import type { AgentConfig } from '../config.js'

/** Runtime context passed to every tool runner. */
export type ToolContext = {
  workspaceRoot: string
  shell: AgentConfig['shell']
  signal?: AbortSignal
}

/** Standard tool execution result. */
export type ToolResult = {
  output: string
  diff?: {
    path: string
    unifiedDiff: string
    before?: string
    after?: string
  }
}

export type ReadInput = {
  path: string
  offset?: number
  limit?: number
}

export type WriteInput = {
  path: string
  content: string
}

export type EditInput = {
  path: string
  old_string: string
  new_string: string
}

export type GlobInput = {
  pattern: string
}

export type GrepInput = {
  pattern: string
  path?: string
  glob?: string
}

export type BashInput = {
  command: string
  cwd?: string
}

export type ToolFn = (input: unknown, ctx: ToolContext) => Promise<ToolResult>

/**
 * Minimal Anthropic tool definition shape (avoids hard dependency on SDK in Task 5).
 * Compatible with Messages API `tools` parameter.
 */
export type AnthropicToolDefinition = {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** Max characters returned in tool output (stdout/content). */
export const MAX_TOOL_OUTPUT_CHARS = 200_000

/** Bash process timeout in milliseconds. */
export const BASH_TIMEOUT_MS = 60_000

/** Max file size for Read (bytes). */
export const MAX_READ_BYTES = 1_000_000
