import fs from 'node:fs'
import { assertInsideWorkspace, toRelative } from '../paths.js'
import { asRecord, optionalPositiveInt, requireString, truncateOutput } from './input.js'
import {
  MAX_READ_BYTES,
  MAX_TOOL_OUTPUT_CHARS,
  type ToolContext,
  type ToolResult,
} from './types.js'

export async function runRead(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const obj = asRecord(input)
  const userPath = requireString(obj, 'path')
  const offset = optionalPositiveInt(obj, 'offset')
  const limit = optionalPositiveInt(obj, 'limit')

  const abs = assertInsideWorkspace(ctx.workspaceRoot, userPath)

  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Read failed: ${msg}`)
  }

  if (!stat.isFile()) {
    throw new Error(`Read failed: not a file: ${toRelative(ctx.workspaceRoot, abs)}`)
  }

  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `Read failed: file exceeds max size (${stat.size} > ${MAX_READ_BYTES} bytes)`,
    )
  }

  const raw = fs.readFileSync(abs, 'utf8')
  let text = raw

  if (offset !== undefined || limit !== undefined) {
    // Lines are 1-indexed. offset defaults to 1 when only limit is set.
    const lines = raw.split('\n')
    // If file ends with trailing newline, split leaves a trailing empty element;
    // treat content as line-oriented without dropping intentional last empty only when...
    // Standard: split keeps empty last if ends with \n — for range we use lines as-is.
    const start = (offset ?? 1) - 1
    if (start < 0 || start >= lines.length) {
      text = ''
    } else {
      const end =
        limit === undefined ? lines.length : Math.min(lines.length, start + limit)
      text = lines.slice(start, end).join('\n')
    }
  }

  return { output: truncateOutput(text, MAX_TOOL_OUTPUT_CHARS) }
}
