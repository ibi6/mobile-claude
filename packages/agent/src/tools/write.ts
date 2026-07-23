import fs from 'node:fs'
import path from 'node:path'
import { assertInsideWorkspace, toRelative } from '../paths.js'
import { createUnifiedDiff } from './diff.js'
import { asRecord, requireString, truncateOutput } from './input.js'
import {
  MAX_READ_BYTES,
  MAX_TOOL_OUTPUT_CHARS,
  type ToolContext,
  type ToolResult,
} from './types.js'

export async function runWrite(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const obj = asRecord(input)
  const userPath = requireString(obj, 'path')
  const content = requireString(obj, 'content')

  const abs = assertInsideWorkspace(ctx.workspaceRoot, userPath)
  const rel = toRelative(ctx.workspaceRoot, abs)

  let before: string | undefined
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const stat = fs.statSync(abs)
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(
        `Write failed: existing file exceeds max size (${stat.size} > ${MAX_READ_BYTES} bytes)`,
      )
    }
    before = fs.readFileSync(abs, 'utf8')
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')

  const after = content
  const unifiedDiff = createUnifiedDiff(rel, before ?? '', after)
  const created = before === undefined

  return {
    output: truncateOutput(
      created ? `Wrote ${rel}` : `Updated ${rel}`,
      MAX_TOOL_OUTPUT_CHARS,
    ),
    diff: {
      path: rel,
      unifiedDiff,
      before,
      after,
    },
  }
}
