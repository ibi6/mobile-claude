import crypto from 'node:crypto'
import type { AppDatabase } from './db.js'

export type SessionRow = {
  id: string
  title: string
  model: string
  created_at: number
  updated_at: number
}

export type MessageRow = {
  id: string
  session_id: string
  role: string
  content: unknown
  sort_index: number
  created_at: number
}

export type PermissionRuleRow = {
  id: string
  session_id: string
  tool: string
  pattern: string
  created_at: number
}

export type AppendMessageInput = {
  role: string
  content: unknown
  id?: string
}

/** Session + message + permission-rule CRUD on SQLite. */
export class SessionStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly defaultModel: string,
  ) {}

  list(): SessionRow[] {
    return this.db.all<SessionRow>(
      'SELECT id, title, model, created_at, updated_at FROM sessions ORDER BY updated_at DESC',
    )
  }

  create(title?: string): SessionRow {
    const now = Date.now()
    const row: SessionRow = {
      id: crypto.randomUUID(),
      title: title?.trim() || 'New session',
      model: this.defaultModel,
      created_at: now,
      updated_at: now,
    }
    this.db.run(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [row.id, row.title, row.model, row.created_at, row.updated_at],
    )
    this.db.persist()
    return row
  }

  get(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>(
      'SELECT id, title, model, created_at, updated_at FROM sessions WHERE id = ?',
      [id],
    )
  }

  delete(id: string): boolean {
    const existing = this.get(id)
    if (!existing) return false
    this.db.run('DELETE FROM messages WHERE session_id = ?', [id])
    this.db.run('DELETE FROM tool_runs WHERE session_id = ?', [id])
    this.db.run('DELETE FROM permission_rules WHERE session_id = ?', [id])
    this.db.run('DELETE FROM sessions WHERE id = ?', [id])
    this.db.persist()
    return true
  }

  appendMessage(sessionId: string, msg: AppendMessageInput): MessageRow {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`session not found: ${sessionId}`)
    }

    const maxRow = this.db.get<{ m: number | null }>(
      'SELECT MAX(sort_index) AS m FROM messages WHERE session_id = ?',
      [sessionId],
    )
    const nextIndex =
      maxRow?.m === null || maxRow?.m === undefined ? 0 : Number(maxRow.m) + 1

    const now = Date.now()
    const row: MessageRow = {
      id: msg.id ?? crypto.randomUUID(),
      session_id: sessionId,
      role: msg.role,
      content: msg.content,
      sort_index: nextIndex,
      created_at: now,
    }

    this.db.run(
      'INSERT INTO messages (id, session_id, role, content_json, sort_index, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        row.id,
        row.session_id,
        row.role,
        JSON.stringify(row.content),
        row.sort_index,
        row.created_at,
      ],
    )
    this.db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [now, sessionId])
    this.db.persist()
    return row
  }

  listMessages(sessionId: string): MessageRow[] {
    const rows = this.db.all<{
      id: string
      session_id: string
      role: string
      content_json: string
      sort_index: number
      created_at: number
    }>(
      'SELECT id, session_id, role, content_json, sort_index, created_at FROM messages WHERE session_id = ? ORDER BY sort_index ASC',
      [sessionId],
    )
    return rows.map((r) => ({
      id: r.id,
      session_id: r.session_id,
      role: r.role,
      content: JSON.parse(r.content_json) as unknown,
      sort_index: r.sort_index,
      created_at: r.created_at,
    }))
  }

  setModel(sessionId: string, model: string): void {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`session not found: ${sessionId}`)
    }
    const now = Date.now()
    this.db.run('UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?', [
      model,
      now,
      sessionId,
    ])
    this.db.persist()
  }

  /**
   * Clear transcript for `/clear`. Keeps the same session id (and rules/model).
   */
  clearMessages(sessionId: string): void {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`session not found: ${sessionId}`)
    }
    this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM tool_runs WHERE session_id = ?', [sessionId])
    this.db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [
      Date.now(),
      sessionId,
    ])
    this.db.persist()
  }

  addPermissionRule(
    sessionId: string,
    tool: string,
    pattern: string,
  ): PermissionRuleRow {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`session not found: ${sessionId}`)
    }
    const existing = this.findPermissionRule(sessionId, tool, pattern)
    if (existing) return existing

    const row: PermissionRuleRow = {
      id: crypto.randomUUID(),
      session_id: sessionId,
      tool,
      pattern,
      created_at: Date.now(),
    }
    this.db.run(
      'INSERT INTO permission_rules (id, session_id, tool, pattern, created_at) VALUES (?, ?, ?, ?, ?)',
      [row.id, row.session_id, row.tool, row.pattern, row.created_at],
    )
    this.db.persist()
    return row
  }

  listPermissionRules(sessionId: string): PermissionRuleRow[] {
    return this.db.all<PermissionRuleRow>(
      'SELECT id, session_id, tool, pattern, created_at FROM permission_rules WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId],
    )
  }

  findPermissionRule(
    sessionId: string,
    tool: string,
    pattern: string,
  ): PermissionRuleRow | undefined {
    return this.db.get<PermissionRuleRow>(
      'SELECT id, session_id, tool, pattern, created_at FROM permission_rules WHERE session_id = ? AND tool = ? AND pattern = ?',
      [sessionId, tool, pattern],
    )
  }

  deletePermissionRule(id: string): boolean {
    const row = this.db.get<{ id: string }>(
      'SELECT id FROM permission_rules WHERE id = ?',
      [id],
    )
    if (!row) return false
    this.db.run('DELETE FROM permission_rules WHERE id = ?', [id])
    this.db.persist()
    return true
  }

  clearPermissionRules(sessionId: string): void {
    this.db.run('DELETE FROM permission_rules WHERE session_id = ?', [sessionId])
    this.db.persist()
  }
}
