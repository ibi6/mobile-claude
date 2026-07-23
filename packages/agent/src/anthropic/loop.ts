/**
 * Anthropic agent loop: stream → permission gate → tools → continue.
 *
 * ## content_json format (locked)
 *
 * User message:
 *   `{ type: 'text', text: string }`
 *
 * Assistant message:
 *   `{ type: 'assistant', text: string, toolUses?: { id, name, input }[] }`
 *
 * Tool results are **not** separate message rows — they live in `tool_runs`
 * linked via `message_id` to the assistant row that issued the tool_use.
 * When rebuilding Anthropic history, tool_runs become `tool_result` blocks
 * in a synthetic user turn after that assistant message.
 */

import crypto from 'node:crypto'
import type { AgentConfig } from '../config.js'
import {
  patternForTool,
  resolvePermission,
  riskForTool,
  type UserDecision,
  type RiskLevel,
} from '../permissions.js'
import type { SessionStore, ToolRunRow } from '../sessionStore.js'
import { anthropicToolDefinitions, runTool } from '../tools/registry.js'
import type { AnthropicToolDefinition, ToolContext } from '../tools/types.js'
import {
  createAnthropicClient,
  type AnthropicMessage,
  type ContentBlock,
  type StreamMessageFn,
  type ToolResultBlock,
} from './client.js'

// ── Stored content shapes ───────────────────────────────────────────────────

export type UserContent = { type: 'text'; text: string }

export type AssistantContent = {
  type: 'assistant'
  text: string
  toolUses?: Array<{ id: string; name: string; input: unknown }>
}

export type SessionPhase = 'idle' | 'thinking' | 'tool' | 'awaiting_permission'

export type PermissionRequest = {
  requestId: string
  toolRunId: string
  name: string
  input: unknown
  risk: RiskLevel
}

export type LoopEvents = {
  onDelta: (text: string, messageId: string) => void
  onToolStarted: (args: {
    toolRunId: string
    name: string
    inputSummary: string
    input: unknown
  }) => void
  onPermissionRequired: (req: PermissionRequest) => Promise<UserDecision>
  onToolCompleted: (args: {
    toolRunId: string
    status: string
    outputSummary: string
    output?: unknown
    /** True when tool output was capped server-side. */
    truncated?: boolean
  }) => void
  onDiff: (args: {
    toolRunId: string
    path: string
    before?: string
    after?: string
    unifiedDiff: string
  }) => void
  onStatus: (
    phase: SessionPhase,
    meta?: { model: string; busy: boolean },
  ) => void
  onMessageCompleted: (args: {
    messageId: string
    stopReason: string
  }) => void
}

export type RunAgentLoopArgs = {
  sessionId: string
  store: SessionStore
  config: AgentConfig
  userText: string
  /** Defaults to anthropicToolDefinitions(). */
  tools?: AnthropicToolDefinition[]
  signal?: AbortSignal
  events: LoopEvents
  /**
   * Injected stream function (tests / custom transports).
   * When omitted, uses createAnthropicClient({ apiKey }).
   */
  streamMessage?: StreamMessageFn
  apiKey?: string
  /** Safety cap on model round-trips per user turn. */
  maxRounds?: number
}

const DEFAULT_MAX_ROUNDS = 25
const TITLE_MAX = 60

/**
 * Run one user turn: append user text, stream with tools, gate permissions,
 * execute tools, persist assistant + tool_runs, continue until end_turn/abort.
 */
export async function runAgentLoop(args: RunAgentLoopArgs): Promise<void> {
  const {
    sessionId,
    store,
    config,
    userText,
    tools = anthropicToolDefinitions(),
    signal,
    events,
    maxRounds = DEFAULT_MAX_ROUNDS,
  } = args

  const session = store.get(sessionId)
  if (!session) {
    throw new Error(`session not found: ${sessionId}`)
  }

  const streamMessage =
    args.streamMessage ?? createAnthropicClient({ apiKey: args.apiKey })

  const model = session.model || config.defaultModel
  const system = buildSystemPrompt(config.workspaceRoot)

  const text = userText.trim()
  if (!text) {
    throw new Error('userText must be non-empty')
  }

  // 1. Append user message
  store.appendMessage(sessionId, {
    role: 'user',
    content: { type: 'text', text } satisfies UserContent,
  })

  // v1 title: first user message truncated when still default
  if (session.title === 'New session') {
    const title =
      text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text
    store.setTitle(sessionId, title)
  }

  const toolCtx: ToolContext = {
    workspaceRoot: config.workspaceRoot,
    shell: config.shell,
    signal,
  }

  try {
    for (let round = 0; round < maxRounds; round++) {
      throwIfAborted(signal)

      events.onStatus('thinking', { model, busy: true })

      // Stable id for this assistant message so deltas can reference it
      const assistantMessageId = crypto.randomUUID()

      const messages = buildAnthropicMessages(store, sessionId)
      const result = await streamMessage(
        {
          model,
          system,
          messages,
          tools,
          signal,
        },
        {
          onTextDelta: (delta) => {
            events.onDelta(delta, assistantMessageId)
          },
        },
      )

      throwIfAborted(signal)

      const toolUses = result.toolUses
      const assistantContent: AssistantContent = {
        type: 'assistant',
        text: result.text,
        ...(toolUses.length > 0 ? { toolUses } : {}),
      }

      // 6. Persist assistant message
      store.appendMessage(sessionId, {
        id: assistantMessageId,
        role: 'assistant',
        content: assistantContent,
      })

      if (toolUses.length === 0) {
        events.onMessageCompleted({
          messageId: assistantMessageId,
          stopReason: result.stopReason,
        })
        break
      }

      // 5. On tool_use → permission → run/deny → tool_result (via tool_runs)
      for (const tu of toolUses) {
        throwIfAborted(signal)
        await executeToolUse({
          sessionId,
          store,
          config,
          toolCtx,
          events,
          assistantMessageId,
          toolUse: tu,
          model,
        })
      }

      // Continue next model round with tool_results in history
    }
  } finally {
    events.onStatus('idle', { model, busy: false })
  }
}

// ── Tool execution + permissions ────────────────────────────────────────────

type ExecuteToolArgs = {
  sessionId: string
  store: SessionStore
  config: AgentConfig
  toolCtx: ToolContext
  events: LoopEvents
  assistantMessageId: string
  toolUse: { id: string; name: string; input: unknown }
  model: string
}

async function executeToolUse(args: ExecuteToolArgs): Promise<void> {
  const {
    sessionId,
    store,
    config,
    toolCtx,
    events,
    assistantMessageId,
    toolUse,
    model,
  } = args

  const toolRunId = toolUse.id || crypto.randomUUID()
  const requestId = crypto.randomUUID()
  const pattern = patternForTool(toolUse.name, toolUse.input)
  const risk = riskForTool(toolUse.name)

  store.appendToolRun(sessionId, {
    id: toolRunId,
    messageId: assistantMessageId,
    name: toolUse.name,
    input: toolUse.input,
    status: 'pending',
  })

  events.onToolStarted({
    toolRunId,
    name: toolUse.name,
    inputSummary: summarizeInput(toolUse.name, toolUse.input),
    input: toolUse.input,
  })

  const rules = store.listPermissionRules(sessionId).map((r) => ({
    tool: r.tool,
    pattern: r.pattern,
  }))

  const decision = resolvePermission({
    tool: toolUse.name,
    pattern,
    sessionId,
    autoAllowReadTools: config.autoAllowReadTools,
    rules,
  })

  if (decision === 'allow') {
    const viaRule = rules.some(
      (r) => r.tool === toolUse.name && r.pattern === pattern,
    )
    store.appendAudit('permission', {
      sessionId,
      toolRunId,
      tool: toolUse.name,
      pattern,
      risk,
      decision: viaRule ? 'allow_session_rule' : 'auto_allow',
    })
  }

  if (decision === 'ask') {
    events.onStatus('awaiting_permission', { model, busy: true })
    // Race AbortSignal so chat.abort unblocks a pending permission wait.
    // Abort is treated as deny (server also resolves pending as deny).
    let userDecision: UserDecision
    try {
      userDecision = await raceAbort(
        events.onPermissionRequired({
          requestId,
          toolRunId,
          name: toolUse.name,
          input: toolUse.input,
          risk,
        }),
        toolCtx.signal,
      )
    } catch (err) {
      if (isAbortError(err) || toolCtx.signal?.aborted) {
        userDecision = 'deny'
      } else {
        throw err
      }
    }

    store.appendAudit('permission', {
      sessionId,
      toolRunId,
      requestId,
      tool: toolUse.name,
      pattern,
      risk,
      decision: userDecision,
    })

    if (userDecision === 'deny') {
      const errText = `Permission denied for tool ${toolUse.name}`
      store.updateToolRun(toolRunId, {
        status: 'denied',
        output: { error: errText },
      })
      events.onToolCompleted({
        toolRunId,
        status: 'denied',
        outputSummary: errText,
        output: { error: errText },
      })
      return
    }

    if (userDecision === 'allow_session') {
      store.addPermissionRule(sessionId, toolUse.name, pattern)
    }
  }

  events.onStatus('tool', { model, busy: true })

  try {
    const result = await runTool(toolUse.name, toolUse.input, toolCtx)
    store.updateToolRun(toolRunId, {
      status: 'completed',
      output: {
        output: result.output,
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.diff ? { diff: result.diff } : {}),
      },
    })

    if (result.diff) {
      events.onDiff({
        toolRunId,
        path: result.diff.path,
        before: result.diff.before,
        after: result.diff.after,
        unifiedDiff: result.diff.unifiedDiff,
      })
    }

    events.onToolCompleted({
      toolRunId,
      status: 'completed',
      outputSummary: truncateSummary(result.output, 200),
      output: result.output,
      ...(result.truncated ? { truncated: true } : {}),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    store.updateToolRun(toolRunId, {
      status: 'error',
      output: { error: msg },
    })
    events.onToolCompleted({
      toolRunId,
      status: 'error',
      outputSummary: msg,
      output: { error: msg },
    })
  }
}

// ── History → Anthropic messages ────────────────────────────────────────────

/**
 * Map store messages + tool_runs into Anthropic Messages API format.
 */
export function buildAnthropicMessages(
  store: SessionStore,
  sessionId: string,
): AnthropicMessage[] {
  const rows = store.listMessages(sessionId)
  const out: AnthropicMessage[] = []

  for (const row of rows) {
    if (row.role === 'user') {
      const userText = extractUserText(row.content)
      if (userText !== null) {
        out.push({ role: 'user', content: userText })
      }
      continue
    }

    if (row.role === 'assistant') {
      const assistant = parseAssistantContent(row.content)
      if (!assistant) continue

      const blocks: ContentBlock[] = []
      if (assistant.text) {
        blocks.push({ type: 'text', text: assistant.text })
      }
      const toolUses = assistant.toolUses ?? []
      for (const tu of toolUses) {
        blocks.push({
          type: 'tool_use',
          id: tu.id,
          name: tu.name,
          input: tu.input ?? {},
        })
      }

      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' })
      }

      out.push({ role: 'assistant', content: blocks })

      if (toolUses.length > 0) {
        const runs = store.listToolRunsForMessage(row.id)
        const resultBlocks = buildToolResultBlocks(toolUses, runs)
        if (resultBlocks.length > 0) {
          out.push({ role: 'user', content: resultBlocks })
        }
      }
    }
  }

  return out
}

function buildToolResultBlocks(
  toolUses: Array<{ id: string; name: string; input: unknown }>,
  runs: ToolRunRow[],
): ToolResultBlock[] {
  const byId = new Map(runs.map((r) => [r.id, r]))
  const blocks: ToolResultBlock[] = []

  for (const tu of toolUses) {
    const run = byId.get(tu.id)
    if (!run) continue

    const isError = run.status === 'denied' || run.status === 'error'
    let content: string
    if (run.status === 'denied' || run.status === 'error') {
      content =
        typeof run.output === 'object' &&
        run.output !== null &&
        'error' in run.output
          ? String((run.output as { error: unknown }).error)
          : run.status === 'denied'
            ? `Permission denied for tool ${tu.name}`
            : `Tool error: ${tu.name}`
    } else {
      content = extractToolOutputString(run.output)
    }

    blocks.push({
      type: 'tool_result',
      tool_use_id: tu.id,
      content,
      ...(isError ? { is_error: true } : {}),
    })
  }

  return blocks
}

function extractToolOutputString(output: unknown): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  if (typeof output === 'object' && output !== null && 'output' in output) {
    const o = (output as { output: unknown }).output
    return typeof o === 'string' ? o : JSON.stringify(o)
  }
  return JSON.stringify(output)
}

function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (
    content !== null &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    (content as { type?: unknown }).type === 'text' &&
    typeof (content as { text?: unknown }).text === 'string'
  ) {
    return (content as { text: string }).text
  }
  return null
}

function parseAssistantContent(content: unknown): AssistantContent | null {
  if (typeof content === 'string') {
    return { type: 'assistant', text: content }
  }
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    return null
  }

  const c = content as Record<string, unknown>
  if (c.type === 'assistant' && typeof c.text === 'string') {
    const toolUses = Array.isArray(c.toolUses)
      ? (c.toolUses as AssistantContent['toolUses'])
      : undefined
    return { type: 'assistant', text: c.text, toolUses }
  }
  if (c.type === 'text' && typeof c.text === 'string') {
    return { type: 'assistant', text: c.text }
  }
  return null
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(workspaceRoot: string): string {
  return [
    "You are a coding agent running on the user's machine via Mobile Claude Code.",
    `Workspace root: ${workspaceRoot}`,
    'Use the provided tools to read, edit, search, and run commands inside the workspace only.',
    'Prefer dedicated file tools (Read/Write/Edit/Glob/Grep) over Bash for file operations.',
    'Be concise. If a tool is denied, respect that and adapt.',
  ].join('\n')
}

function summarizeInput(name: string, input: unknown): string {
  const pattern = patternForTool(name, input)
  if (pattern) return `${name} ${pattern}`.slice(0, 200)
  try {
    return `${name} ${JSON.stringify(input)}`.slice(0, 200)
  } catch {
    return name
  }
}

function truncateSummary(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason
    if (reason instanceof Error) throw reason
    throw new Error(typeof reason === 'string' ? reason : 'aborted')
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  return new Error(typeof reason === 'string' ? reason : 'aborted')
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message.toLowerCase()
  return msg === 'aborted' || msg.includes('abort') || err.name === 'AbortError'
}

/**
 * Resolve `promise`, or reject immediately when `signal` aborts.
 * Ensures permission waits do not hang after chat.abort.
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(abortError(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (err: unknown) => {
        cleanup()
        reject(err)
      },
    )
  })
}
