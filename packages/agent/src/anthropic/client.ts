/**
 * Anthropic Messages streaming client.
 *
 * Production path uses `@anthropic-ai/sdk`. Tests inject `streamMessage`
 * so no API key or network is required.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { AnthropicToolDefinition } from '../tools/types.js'

// ── Anthropic message shapes (subset used by the agent loop) ────────────────

export type TextBlock = { type: 'text'; text: string }

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export type StreamMessageParams = {
  model: string
  system: string
  messages: AnthropicMessage[]
  tools: AnthropicToolDefinition[]
  maxTokens?: number
  signal?: AbortSignal
}

export type StreamMessageResult = {
  text: string
  toolUses: Array<{ id: string; name: string; input: unknown }>
  stopReason: string
}

export type StreamMessageHandlers = {
  onTextDelta: (text: string) => void
}

/**
 * Stream one assistant turn. Emits text deltas via handlers; returns full
 * accumulated text + tool_use blocks when the stream ends.
 */
export type StreamMessageFn = (
  params: StreamMessageParams,
  handlers: StreamMessageHandlers,
) => Promise<StreamMessageResult>

export type CreateAnthropicClientOptions = {
  apiKey?: string
  /** Override for tests (mock streams). When set, apiKey is unused. */
  streamMessage?: StreamMessageFn
}

/**
 * Build a `streamMessage` implementation.
 * - If `streamMessage` is provided, returns it as-is (test / DI path).
 * - Otherwise constructs an Anthropic SDK client from `apiKey` or env.
 */
export function createAnthropicClient(
  opts: CreateAnthropicClientOptions = {},
): StreamMessageFn {
  if (opts.streamMessage) {
    return opts.streamMessage
  }

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required (env or createAnthropicClient({ apiKey }))',
    )
  }

  const client = new Anthropic({ apiKey })

  return async function streamMessageWithSdk(
    params: StreamMessageParams,
    handlers: StreamMessageHandlers,
  ): Promise<StreamMessageResult> {
    throwIfAborted(params.signal)

    const stream = client.messages.stream(
      {
        model: params.model,
        max_tokens: params.maxTokens ?? 8192,
        system: params.system,
        messages: params.messages as Anthropic.MessageParam[],
        tools: params.tools as Anthropic.Tool[],
      },
      params.signal ? { signal: params.signal } : undefined,
    )

    stream.on('text', (text) => {
      handlers.onTextDelta(text)
    })

    const final = await stream.finalMessage()

    const toolUses: StreamMessageResult['toolUses'] = []
    let text = ''
    for (const block of final.content) {
      if (block.type === 'text') {
        text += block.text
      } else if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: block.input,
        })
      }
    }

    return {
      text,
      toolUses,
      stopReason: final.stop_reason ?? 'end_turn',
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason
    if (reason instanceof Error) throw reason
    throw new Error(typeof reason === 'string' ? reason : 'aborted')
  }
}
