import fs from 'node:fs'
import path from 'node:path'
import { assertInsideWorkspace, toRelative } from '../paths.js'
import { asRecord, requireString, truncateOutput } from './input.js'
import { MAX_TOOL_OUTPUT_CHARS, type ToolContext, type ToolResult } from './types.js'

/**
 * Glob files under workspaceRoot.
 * Patterns are relative to workspace; results are workspace-relative forward-slash paths.
 */
export async function runGlob(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const obj = asRecord(input)
  const pattern = requireString(obj, 'pattern')
  if (!pattern) {
    throw new Error('Glob failed: pattern must not be empty')
  }

  const rootReal = fs.realpathSync(ctx.workspaceRoot)
  const matches: string[] = []

  // Prefer Node built-in glob when available (Node 22+)
  if (typeof fs.promises.glob === 'function') {
    for await (const entry of fs.promises.glob(pattern, {
      cwd: rootReal,
      withFileTypes: false,
    })) {
      const abs = path.isAbsolute(entry)
        ? entry
        : path.resolve(rootReal, entry)
      try {
        const safe = assertInsideWorkspace(ctx.workspaceRoot, abs)
        if (fs.existsSync(safe) && fs.statSync(safe).isFile()) {
          matches.push(toRelative(ctx.workspaceRoot, safe))
        }
      } catch {
        // skip escapes / errors
      }
    }
  } else {
    walkMatch(rootReal, rootReal, pattern, matches, ctx)
  }

  matches.sort((a, b) => a.localeCompare(b))
  return { output: truncateOutput(matches.join('\n'), MAX_TOOL_OUTPUT_CHARS) }
}

function walkMatch(
  rootReal: string,
  dir: string,
  pattern: string,
  out: string[],
  ctx: ToolContext,
): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const ent of entries) {
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      walkMatch(rootReal, abs, pattern, out, ctx)
      continue
    }
    if (!ent.isFile()) continue
    const rel = path.relative(rootReal, abs).split(path.sep).join('/')
    if (matchGlob(pattern, rel)) {
      try {
        const safe = assertInsideWorkspace(ctx.workspaceRoot, abs)
        out.push(toRelative(ctx.workspaceRoot, safe))
      } catch {
        // skip
      }
    }
  }
}

/**
 * Minimal glob matcher: supports `*`, `**`, `?`.
 * `**` matches across path segments; `*` does not cross `/`.
 */
export function matchGlob(pattern: string, relPath: string): boolean {
  const normPattern = pattern.replace(/\\/g, '/')
  const normPath = relPath.replace(/\\/g, '/')
  return matchSegments(normPattern.split('/'), normPath.split('/'), 0, 0)
}

function matchSegments(
  patParts: string[],
  pathParts: string[],
  pi: number,
  si: number,
): boolean {
  while (pi < patParts.length && si < pathParts.length) {
    const p = patParts[pi]!
    if (p === '**') {
      // Greedy: try consume zero or more segments
      if (pi === patParts.length - 1) return true
      for (let k = si; k <= pathParts.length; k++) {
        if (matchSegments(patParts, pathParts, pi + 1, k)) return true
      }
      return false
    }
    if (!matchOneSegment(p, pathParts[si]!)) return false
    pi++
    si++
  }

  // Trailing ** only
  while (pi < patParts.length && patParts[pi] === '**') pi++
  return pi === patParts.length && si === pathParts.length
}

function matchOneSegment(pat: string, seg: string): boolean {
  let i = 0
  let j = 0
  let star = -1
  let match = 0

  while (j < seg.length) {
    if (i < pat.length && (pat[i] === '?' || pat[i] === seg[j])) {
      i++
      j++
    } else if (i < pat.length && pat[i] === '*') {
      star = i
      match = j
      i++
    } else if (star !== -1) {
      i = star + 1
      match++
      j = match
    } else {
      return false
    }
  }

  while (i < pat.length && pat[i] === '*') i++
  return i === pat.length
}
