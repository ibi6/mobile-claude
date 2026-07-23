import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, type AppDatabase } from '../db'
import { SessionStore } from '../sessionStore'
import type { AgentConfig } from '../config'
import {
  runAgentLoop,
  buildAnthropicMessages,
  type LoopEvents,
  type SessionPhase,
} from '../anthropic/loop'
import type {
  StreamMessageFn,
  StreamMessageParams,
  StreamMessageResult,
} from '../anthropic/client'
import type { UserDecision } from '../permissions'

function makeConfig(workspaceRoot: string): AgentConfig {
  return {
    host: '127.0.0.1',
    port: 7820,
    workspaceRoot,
    dataDir: path.join(workspaceRoot, '.data'),
    defaultModel: 'claude-sonnet-4-20250514',
    shell: process.platform === 'win32' ? 'powershell' : 'bash',
    autoAllowReadTools: true,
    pairingCodeTtlMs: 600_000,
  }
}

function collectEvents(overrides: Partial<LoopEvents> = {}) {
  const deltas: Array<{ text: string; messageId: string }> = []
  const toolsStarted: Array<{ name: string; toolRunId: string }> = []
  const toolsCompleted: Array<{ status: string; toolRunId: string }> = []
  const diffs: Array<{ path: string; after?: string }> = []
  const statuses: SessionPhase[] = []
  const completed: Array<{ messageId: string; stopReason: string }> = []
  const permissions: Array<{ name: string; risk: string }> = []

  const events: LoopEvents = {
    onDelta: (text, messageId) => {
      deltas.push({ text, messageId })
    },
    onToolStarted: (args) => {
      toolsStarted.push({ name: args.name, toolRunId: args.toolRunId })
    },
    onPermissionRequired: async (req) => {
      permissions.push({ name: req.name, risk: req.risk })
      if (overrides.onPermissionRequired) {
        return overrides.onPermissionRequired(req)
      }
      return 'allow_once'
    },
    onToolCompleted: (args) => {
      toolsCompleted.push({ status: args.status, toolRunId: args.toolRunId })
    },
    onDiff: (args) => {
      diffs.push({ path: args.path, after: args.after })
    },
    onStatus: (phase) => {
      statuses.push(phase)
    },
    onMessageCompleted: (args) => {
      completed.push(args)
    },
    ...overrides,
  }

  // Re-bind permission after spread so collector still records
  const userPerm = overrides.onPermissionRequired
  events.onPermissionRequired = async (req) => {
    permissions.push({ name: req.name, risk: req.risk })
    if (userPerm) return userPerm(req)
    return 'allow_once'
  }

  return {
    events,
    deltas,
    toolsStarted,
    toolsCompleted,
    diffs,
    statuses,
    completed,
    permissions,
  }
}

/**
 * Scripted multi-round mock: each call to streamMessage pops the next result.
 * Text deltas are emitted before returning.
 */
function scriptedStream(
  rounds: Array<
    | StreamMessageResult
    | ((params: StreamMessageParams) => StreamMessageResult)
  >,
): StreamMessageFn {
  let i = 0
  return async (params, handlers) => {
    if (i >= rounds.length) {
      throw new Error(`mock stream: unexpected round ${i + 1}`)
    }
    const entry = rounds[i]!
    i += 1
    const result = typeof entry === 'function' ? entry(params) : entry
    if (result.text) {
      // Simulate chunked deltas
      const mid = Math.ceil(result.text.length / 2)
      handlers.onTextDelta(result.text.slice(0, mid))
      handlers.onTextDelta(result.text.slice(mid))
    }
    return result
  }
}

describe('runAgentLoop (mock Anthropic)', () => {
  let workspace: string
  let dataDir: string
  let db: AppDatabase
  let store: SessionStore

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-loop-ws-'))
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-loop-db-'))
    db = await openDb(dataDir)
    store = new SessionStore(db, 'claude-sonnet-4-20250514')
  })

  afterEach(() => {
    db.close()
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('streams text-only turn: deltas, persist, message completed', async () => {
    const session = store.create()
    const collected = collectEvents()
    const streamMessage = scriptedStream([
      {
        text: 'Hello from mock',
        toolUses: [],
        stopReason: 'end_turn',
      },
    ])

    await runAgentLoop({
      sessionId: session.id,
      store,
      config: makeConfig(workspace),
      userText: 'say hi',
      streamMessage,
      events: collected.events,
    })

    expect(collected.deltas.map((d) => d.text).join('')).toBe('Hello from mock')
    expect(collected.completed).toHaveLength(1)
    expect(collected.completed[0]!.stopReason).toBe('end_turn')
    expect(collected.statuses[0]).toBe('thinking')
    expect(collected.statuses.at(-1)).toBe('idle')

    const msgs = store.listMessages(session.id)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]!.role).toBe('user')
    expect(msgs[0]!.content).toEqual({ type: 'text', text: 'say hi' })
    expect(msgs[1]!.role).toBe('assistant')
    expect(msgs[1]!.content).toMatchObject({
      type: 'assistant',
      text: 'Hello from mock',
    })

    // Title from first user message
    expect(store.get(session.id)?.title).toBe('say hi')
  })

  it('tool_use Write → allow_once → file created + tool_runs + second round', async () => {
    const session = store.create()
    const collected = collectEvents({
      onPermissionRequired: async () => 'allow_once' as UserDecision,
    })

    const toolId = 'toolu_write_1'
    const streamMessage = scriptedStream([
      {
        text: 'I will write the file.',
        toolUses: [
          {
            id: toolId,
            name: 'Write',
            input: { path: 'hello.txt', content: 'from agent loop' },
          },
        ],
        stopReason: 'tool_use',
      },
      (params) => {
        // Second round should include tool_result for Write
        const last = params.messages[params.messages.length - 1]
        expect(last?.role).toBe('user')
        if (typeof last?.content !== 'string') {
          const blocks = last!.content
          const tr = blocks.find(
            (b) => b.type === 'tool_result' && b.tool_use_id === toolId,
          )
          expect(tr).toBeDefined()
          expect(tr && 'is_error' in tr ? tr.is_error : false).toBeFalsy()
        }
        return {
          text: 'Done writing hello.txt',
          toolUses: [],
          stopReason: 'end_turn',
        }
      },
    ])

    await runAgentLoop({
      sessionId: session.id,
      store,
      config: makeConfig(workspace),
      userText: 'create hello.txt',
      streamMessage,
      events: collected.events,
    })

    expect(collected.permissions).toHaveLength(1)
    expect(collected.permissions[0]).toEqual({ name: 'Write', risk: 'medium' })
    expect(collected.toolsStarted).toEqual([
      { name: 'Write', toolRunId: toolId },
    ])
    expect(collected.toolsCompleted).toEqual([
      { status: 'completed', toolRunId: toolId },
    ])
    expect(collected.diffs).toHaveLength(1)
    expect(collected.diffs[0]!.path).toContain('hello.txt')
    expect(collected.diffs[0]!.after).toBe('from agent loop')
    expect(collected.completed).toHaveLength(1)
    expect(collected.completed[0]!.stopReason).toBe('end_turn')

    const filePath = path.join(workspace, 'hello.txt')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('from agent loop')

    const runs = store.listToolRuns(session.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.name).toBe('Write')
    expect(runs[0]!.status).toBe('completed')
    expect(runs[0]!.id).toBe(toolId)

    const msgs = store.listMessages(session.id)
    // user + assistant(tool) + assistant(final)
    expect(msgs).toHaveLength(3)
    expect(msgs[1]!.content).toMatchObject({
      type: 'assistant',
      toolUses: [{ id: toolId, name: 'Write' }],
    })

    // Spec: audit_log on permission decisions
    const audits = store.listAudit(10, 'permission')
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(audits[0]!.detail).toMatchObject({
      sessionId: session.id,
      tool: 'Write',
      decision: 'allow_once',
      toolRunId: toolId,
    })
  })

  it('deny synthesizes tool_result error and continues', async () => {
    const session = store.create()
    const collected = collectEvents({
      onPermissionRequired: async () => 'deny',
    })

    const toolId = 'toolu_deny_1'
    const streamMessage = scriptedStream([
      {
        text: '',
        toolUses: [
          {
            id: toolId,
            name: 'Bash',
            input: { command: 'echo no' },
          },
        ],
        stopReason: 'tool_use',
      },
      (params) => {
        const last = params.messages[params.messages.length - 1]
        expect(last?.role).toBe('user')
        if (Array.isArray(last?.content)) {
          const tr = last.content.find(
            (b) => b.type === 'tool_result' && b.tool_use_id === toolId,
          )
          expect(tr).toMatchObject({
            type: 'tool_result',
            is_error: true,
          })
          if (tr && tr.type === 'tool_result') {
            expect(tr.content).toMatch(/denied/i)
          }
        }
        return {
          text: 'Understood, skipped bash.',
          toolUses: [],
          stopReason: 'end_turn',
        }
      },
    ])

    await runAgentLoop({
      sessionId: session.id,
      store,
      config: makeConfig(workspace),
      userText: 'run something',
      streamMessage,
      events: collected.events,
    })

    expect(collected.toolsCompleted[0]!.status).toBe('denied')
    expect(store.listToolRuns(session.id)[0]!.status).toBe('denied')

    const audits = store.listAudit(10, 'permission')
    expect(audits.some((a) => (a.detail as { decision: string }).decision === 'deny')).toBe(
      true,
    )
  })

  it('allow_session stores rule so second call skips prompt', async () => {
    const session = store.create()
    const perm = vi.fn(async (): Promise<UserDecision> => 'allow_session')

    const streamMessage = scriptedStream([
      {
        text: '',
        toolUses: [
          {
            id: 'toolu_w1',
            name: 'Write',
            input: { path: 'a.txt', content: 'one' },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        text: 'ok',
        toolUses: [],
        stopReason: 'end_turn',
      },
    ])

    await runAgentLoop({
      sessionId: session.id,
      store,
      config: makeConfig(workspace),
      userText: 'write a',
      streamMessage,
      events: collectEvents({ onPermissionRequired: perm }).events,
    })

    expect(perm).toHaveBeenCalledTimes(1)
    expect(store.findPermissionRule(session.id, 'Write', 'a.txt')).toBeTruthy()

    // Second turn same path — no permission prompt
    const perm2 = vi.fn(async (): Promise<UserDecision> => 'allow_once')
    const stream2 = scriptedStream([
      {
        text: '',
        toolUses: [
          {
            id: 'toolu_w2',
            name: 'Write',
            input: { path: 'a.txt', content: 'two' },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        text: 'updated',
        toolUses: [],
        stopReason: 'end_turn',
      },
    ])

    await runAgentLoop({
      sessionId: session.id,
      store,
      config: makeConfig(workspace),
      userText: 'write a again',
      streamMessage: stream2,
      events: collectEvents({ onPermissionRequired: perm2 }).events,
    })

    expect(perm2).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('two')
  })

  it('auto-allows Read without permission sheet', async () => {
    fs.writeFileSync(path.join(workspace, 'r.txt'), 'secret')
    const session = store.create()
    const perm = vi.fn(async (): Promise<UserDecision> => 'allow_once')

    const streamMessage = scriptedStream([
      {
        text: '',
        toolUses: [
          { id: 'toolu_r1', name: 'Read', input: { path: 'r.txt' } },
        ],
        stopReason: 'tool_use',
      },
      {
        text: 'content is secret',
        toolUses: [],
        stopReason: 'end_turn',
      },
    ])

    await runAgentLoop({
      sessionId: session.id,
      store,
      config: makeConfig(workspace),
      userText: 'read r.txt',
      streamMessage,
      events: collectEvents({ onPermissionRequired: perm }).events,
    })

    expect(perm).not.toHaveBeenCalled()
    expect(store.listToolRuns(session.id)[0]!.status).toBe('completed')
  })

  it('buildAnthropicMessages maps tool_runs to tool_result blocks', () => {
    const session = store.create()
    store.appendMessage(session.id, {
      role: 'user',
      content: { type: 'text', text: 'hi' },
    })
    const asst = store.appendMessage(session.id, {
      role: 'assistant',
      content: {
        type: 'assistant',
        text: 'writing',
        toolUses: [
          { id: 't1', name: 'Write', input: { path: 'x', content: 'y' } },
        ],
      },
    })
    store.appendToolRun(session.id, {
      id: 't1',
      messageId: asst.id,
      name: 'Write',
      input: { path: 'x', content: 'y' },
      output: { output: 'wrote x' },
      status: 'completed',
    })

    const api = buildAnthropicMessages(store, session.id)
    expect(api).toHaveLength(3)
    expect(api[0]).toEqual({ role: 'user', content: 'hi' })
    expect(api[1]!.role).toBe('assistant')
    expect(api[2]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: 'wrote x',
        },
      ],
    })
  })

  it('respects AbortSignal between rounds', async () => {
    const session = store.create()
    const ac = new AbortController()
    let calls = 0
    const streamMessage: StreamMessageFn = async (_p, handlers) => {
      calls += 1
      if (calls === 1) {
        handlers.onTextDelta('using tool')
        return {
          text: 'using tool',
          toolUses: [
            {
              id: 'toolu_ab',
              name: 'Write',
              input: { path: 'x.txt', content: 'x' },
            },
          ],
          stopReason: 'tool_use',
        }
      }
      return { text: 'should not run', toolUses: [], stopReason: 'end_turn' }
    }

    // Abort after tool completes so the next model round sees the signal
    const collected = collectEvents({
      onPermissionRequired: async () => 'allow_once',
      onToolCompleted: () => {
        ac.abort()
      },
    })

    await expect(
      runAgentLoop({
        sessionId: session.id,
        store,
        config: makeConfig(workspace),
        userText: 'go',
        streamMessage,
        signal: ac.signal,
        events: collected.events,
      }),
    ).rejects.toThrow(/abort/i)

    expect(calls).toBe(1)
  })

  it('aborts while awaiting onPermissionRequired (does not hang)', async () => {
    const session = store.create('perm-abort')
    fs.writeFileSync(path.join(workspace, 'x.txt'), 'x')

    const ac = new AbortController()
    let releasePermission: ((d: UserDecision) => void) | undefined

    const streamMessage: StreamMessageFn = async () => ({
      text: 'need write',
      toolUses: [
        {
          id: 'toolu_perm_abort',
          name: 'Write',
          input: { path: 'y.txt', content: 'y' },
        },
      ],
      stopReason: 'tool_use',
    })

    const collected = collectEvents({
      onPermissionRequired: () =>
        new Promise<UserDecision>((resolve) => {
          releasePermission = resolve
          // Abort while the gate is open — raceAbort must unblock
          queueMicrotask(() => ac.abort(new Error('aborted')))
        }),
    })

    await expect(
      runAgentLoop({
        sessionId: session.id,
        store,
        config: {
          ...makeConfig(workspace),
          autoAllowReadTools: false,
        },
        userText: 'write',
        streamMessage,
        signal: ac.signal,
        events: collected.events,
      }),
    ).rejects.toThrow(/abort/i)

    // Permission promise may still be pending; resolve to avoid unhandled hang in test
    releasePermission?.('deny')
  })
})
