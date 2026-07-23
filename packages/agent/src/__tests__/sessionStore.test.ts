import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, type AppDatabase } from '../db'
import { SessionStore } from '../sessionStore'

describe('SessionStore', () => {
  let dataDir: string
  let db: AppDatabase
  let store: SessionStore

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ss-'))
    db = await openDb(dataDir)
    store = new SessionStore(db, 'claude-sonnet-4-20250514')
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('creates a session with default model and empty title fallback', () => {
    const s = store.create()
    expect(s.id).toBeTruthy()
    expect(s.title).toBe('New session')
    expect(s.model).toBe('claude-sonnet-4-20250514')
    expect(s.created_at).toBeTypeOf('number')
    expect(s.updated_at).toBe(s.created_at)

    const got = store.get(s.id)
    expect(got).toEqual(s)
  })

  it('creates a session with custom title', () => {
    const s = store.create('My project')
    expect(s.title).toBe('My project')
  })

  it('lists sessions ordered by updated_at desc', async () => {
    const a = store.create('A')
    await new Promise((r) => setTimeout(r, 5))
    const b = store.create('B')
    // touch A so it becomes most recently updated
    store.setModel(a.id, 'claude-opus-4-20250514')

    const list = store.list()
    expect(list.map((s) => s.id)).toEqual([a.id, b.id])
    expect(list[0]!.model).toBe('claude-opus-4-20250514')
  })

  it('appends user/assistant messages and lists them ordered by sort_index', () => {
    const s = store.create('chat')
    const u = store.appendMessage(s.id, {
      role: 'user',
      content: { type: 'text', text: 'hello' },
    })
    const a = store.appendMessage(s.id, {
      role: 'assistant',
      content: { type: 'text', text: 'hi' },
    })

    expect(u.sort_index).toBe(0)
    expect(a.sort_index).toBe(1)

    const msgs = store.listMessages(s.id)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[0]!.content).toEqual({ type: 'text', text: 'hello' })
    expect(msgs[1]!.role).toBe('assistant')
    expect(msgs[1]!.content).toEqual({ type: 'text', text: 'hi' })
    expect(msgs[0]!.sort_index).toBeLessThan(msgs[1]!.sort_index)
  })

  it('clearMessages keeps session id and removes messages', () => {
    const s = store.create('clear-me')
    store.appendMessage(s.id, { role: 'user', content: 'x' })
    store.appendMessage(s.id, { role: 'assistant', content: 'y' })

    store.clearMessages(s.id)

    expect(store.get(s.id)?.id).toBe(s.id)
    expect(store.listMessages(s.id)).toEqual([])

    // new messages restart sort_index
    const next = store.appendMessage(s.id, { role: 'user', content: 'again' })
    expect(next.sort_index).toBe(0)
  })

  it('deletes session and its messages', () => {
    const s = store.create()
    store.appendMessage(s.id, { role: 'user', content: 'bye' })
    expect(store.delete(s.id)).toBe(true)
    expect(store.get(s.id)).toBeUndefined()
    expect(store.listMessages(s.id)).toEqual([])
    expect(store.delete(s.id)).toBe(false)
  })

  it('permission rule allow_session lookup by tool + pattern', () => {
    const s = store.create()
    const rule = store.addPermissionRule(s.id, 'Write', 'src/a.ts')
    expect(rule.tool).toBe('Write')
    expect(rule.pattern).toBe('src/a.ts')

    const found = store.findPermissionRule(s.id, 'Write', 'src/a.ts')
    expect(found?.id).toBe(rule.id)

    expect(store.findPermissionRule(s.id, 'Write', 'src/b.ts')).toBeUndefined()
    expect(store.findPermissionRule(s.id, 'Bash', 'src/a.ts')).toBeUndefined()

    const listed = store.listPermissionRules(s.id)
    expect(listed).toHaveLength(1)

    expect(store.deletePermissionRule(rule.id)).toBe(true)
    expect(store.findPermissionRule(s.id, 'Write', 'src/a.ts')).toBeUndefined()
  })

  it('clearPermissionRules removes all rules for a session', () => {
    const s = store.create()
    const other = store.create()
    store.addPermissionRule(s.id, 'Write', 'a.ts')
    store.addPermissionRule(s.id, 'Edit', 'b.ts')
    store.addPermissionRule(other.id, 'Write', 'c.ts')

    store.clearPermissionRules(s.id)

    expect(store.listPermissionRules(s.id)).toEqual([])
    expect(store.listPermissionRules(other.id)).toHaveLength(1)
  })

  it('listMessages skips rows with invalid content_json', () => {
    const s = store.create('bad-json')
    store.appendMessage(s.id, { role: 'user', content: { type: 'text', text: 'ok' } })
    db.run(
      'INSERT INTO messages (id, session_id, role, content_json, sort_index, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['bad-msg', s.id, 'assistant', '{not-json', 1, Date.now()],
    )
    db.persist()

    const msgs = store.listMessages(s.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.role).toBe('user')
  })

  it('persists data across reopen', async () => {
    const s = store.create('persist')
    store.appendMessage(s.id, { role: 'user', content: 'keep me' })
    store.addPermissionRule(s.id, 'Edit', 'pkg/x.ts')
    db.persist()
    db.close()

    db = await openDb(dataDir)
    store = new SessionStore(db, 'claude-sonnet-4-20250514')

    expect(store.get(s.id)?.title).toBe('persist')
    expect(store.listMessages(s.id)).toHaveLength(1)
    expect(store.findPermissionRule(s.id, 'Edit', 'pkg/x.ts')).toBeTruthy()
  })

  it('appendAudit / listAudit round-trip permission decisions', () => {
    const s = store.create('audit')
    store.appendAudit('permission', {
      sessionId: s.id,
      tool: 'Write',
      decision: 'allow_once',
    })
    store.appendAudit('permission', {
      sessionId: s.id,
      tool: 'Read',
      decision: 'auto_allow',
    })
    store.appendAudit('tool', { sessionId: s.id, name: 'Bash' })

    const perms = store.listAudit(10, 'permission')
    expect(perms).toHaveLength(2)
    expect(perms.map((r) => (r.detail as { decision: string }).decision).sort()).toEqual([
      'allow_once',
      'auto_allow',
    ])
    expect(perms.every((r) => r.kind === 'permission')).toBe(true)
    expect(perms[0]!.ts).toBeGreaterThanOrEqual(perms[1]!.ts)

    const all = store.listAudit(10)
    expect(all).toHaveLength(3)
  })
})
