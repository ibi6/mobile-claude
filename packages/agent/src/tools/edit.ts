import fs from 'node:fs'
import { assertInsideWorkspace, toRelative } from '../paths.js'
import { createUnifiedDiff } from './diff.js'
import { asRecord, requireString, truncateOutput } from './input.js'
import {
  MAX_READ_BYTES,
  MAX_TOOL_OUTPUT_CHARS,
  type ToolContext,
  type ToolResult,
} from './types.js'

export async function runEdit(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const obj = asRecord(input)
  const userPath = requireString(obj, 'path')
  const oldString = requireString(obj, 'old_string')
  const newString = requireString(obj, 'new_string')

  if (oldString === '') {
    throw new Error('Edit failed: old_string must not be empty')
  }

  const abs = assertInsideWorkspace(ctx.workspaceRoot, userPath)
  const rel = toRelative(ctx.workspaceRoot, abs)

  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`Edit failed: file not found: ${rel}`)
  }

  const stat = fs.statSync(abs)
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `Edit failed: file exceeds max size (${stat.size} > ${MAX_READ_BYTES} bytes)`,
    )
  }

  const before = fs.readFileSync(abs, 'utf8')
  const index = before.indexOf(oldString)
  if (index === -1) {
    throw new Error(`Edit failed: old_string not found in ${rel}`)
  }

  // Replace first occurrence only
  const after =
    before.slice(0, index) + newString + before.slice(index + oldString.length)

  fs.writeFileSync(abs, after, 'utf8')

  return {
    output: truncateOutput(`Edited ${rel}`, MAX_TOOL_OUTPUT_CHARS),
    diff: {
      path: rel,
      unifiedDiff: createUnifiedDiff(rel, before, after),
      before,
      after,
    },
  }
}
