import { runBash } from './bash.js'
import { runEdit } from './edit.js'
import { runGlob } from './glob.js'
import { runGrep } from './grep.js'
import { runRead } from './read.js'
import { runWrite } from './write.js'
import type {
  AnthropicToolDefinition,
  ToolContext,
  ToolFn,
  ToolResult,
} from './types.js'

const TOOLS: Record<string, ToolFn> = {
  Read: runRead,
  Write: runWrite,
  Edit: runEdit,
  Glob: runGlob,
  Grep: runGrep,
  Bash: runBash,
}

/**
 * Dispatch a named tool by exact name (case-sensitive).
 */
export async function runTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fn = TOOLS[name]
  if (!fn) {
    throw new Error(`unknown tool: ${name}`)
  }
  return fn(input, ctx)
}

/**
 * Anthropic Messages API tool schemas for the six sandboxed coding tools.
 */
export function anthropicToolDefinitions(): AnthropicToolDefinition[] {
  return [
    {
      name: 'Read',
      description:
        'Read a file inside the workspace. Optional 1-indexed offset/limit for line ranges.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to workspace or absolute inside it' },
          offset: {
            type: 'integer',
            minimum: 1,
            description: '1-indexed start line',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            description: 'Max number of lines to return',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'Write',
      description:
        'Create or overwrite a file inside the workspace. Creates parent directories as needed.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Target file path' },
          content: { type: 'string', description: 'Full file contents to write' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'Edit',
      description:
        'Replace the first occurrence of old_string with new_string in a file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to edit' },
          old_string: { type: 'string', description: 'Exact text to find' },
          new_string: { type: 'string', description: 'Replacement text' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'Glob',
      description: 'List files under the workspace matching a glob pattern.',
      input_schema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern relative to workspace (e.g. **/*.ts)',
          },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'Grep',
      description:
        'Search file contents under the workspace (ripgrep if available, else fallback).',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex search pattern' },
          path: {
            type: 'string',
            description: 'Optional file or directory scope inside workspace',
          },
          glob: {
            type: 'string',
            description: 'Optional filename glob filter (e.g. *.ts)',
          },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'Bash',
      description:
        'Run a shell command with cwd constrained to the workspace. Timeout 60s.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: {
            type: 'string',
            description: 'Working directory (must stay inside workspace)',
          },
        },
        required: ['command'],
      },
    },
  ]
}

export { TOOLS }
