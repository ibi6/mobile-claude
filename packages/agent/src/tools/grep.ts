import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assertInsideWorkspace, toRelative, PathEscapeError } from '../paths.js'
import { matchGlob } from './glob.js'
import { asRecord, optionalString, requireString, truncateOutput } from './input.js'
import { MAX_TOOL_OUTPUT_CHARS, type ToolContext, type ToolResult } from './types.js'

/**
 * Content search under workspace.
 * Uses `rg` when available; otherwise a recursive TS walk.
 */
export async function runGrep(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const obj = asRecord(input)
  const pattern = requireString(obj, 'pattern')
  if (!pattern) {
    throw new Error('Grep failed: pattern must not be empty')
  }
  const userPath = optionalString(obj, 'path')
  const globFilter = optionalString(obj, 'glob')

  const searchRoot = userPath
    ? assertInsideWorkspace(ctx.workspaceRoot, userPath)
    : fs.realpathSync(ctx.workspaceRoot)

  // Ensure directory or file stays inside workspace
  assertInsideWorkspace(ctx.workspaceRoot, searchRoot)

  const rgOut = await tryRipgrep(pattern, searchRoot, globFilter, ctx)
  if (rgOut !== null) {
    return { output: truncateOutput(rgOut, MAX_TOOL_OUTPUT_CHARS) }
  }

  const lines = tsGrep(pattern, searchRoot, globFilter, ctx)
  return { output: truncateOutput(lines.join('\n'), MAX_TOOL_OUTPUT_CHARS) }
}

async function tryRipgrep(
  pattern: string,
  searchRoot: string,
  globFilter: string | undefined,
  ctx: ToolContext,
): Promise<string | null> {
  const args = ['--line-number', '--no-heading', '--color', 'never', '-e', pattern]
  if (globFilter) {
    args.push('--glob', globFilter)
  }
  args.push(searchRoot)

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let child
    try {
      child = spawn('rg', args, {
        cwd: ctx.workspaceRoot,
        windowsHide: true,
      })
    } catch {
      finish(null)
      return
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      // rg: 0 matches, 1 no matches, 2 error
      if (code === 0 || code === 1) {
        // Rewrite absolute paths to workspace-relative where possible
        const normalized = stdout
          .split('\n')
          .filter((l) => l.length > 0)
          .map((line) => relativizeRgLine(line, ctx))
          .join('\n')
        finish(normalized)
        return
      }
      void stderr
      finish(null)
    })
  })
}

function relativizeRgLine(line: string, ctx: ToolContext): string {
  // format: path:line:content  (Windows may include drive letters)
  const m = line.match(/^(.*?):(\d+):(.*)$/)
  if (!m) return line
  const filePath = m[1]!
  const lineNo = m[2]!
  const content = m[3]!
  try {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(ctx.workspaceRoot, filePath)
    const safe = assertInsideWorkspace(ctx.workspaceRoot, abs)
    const rel = toRelative(ctx.workspaceRoot, safe)
    return `${rel}:${lineNo}:${content}`
  } catch {
    return line
  }
}

function tsGrep(
  pattern: string,
  searchRoot: string,
  globFilter: string | undefined,
  ctx: ToolContext,
): string[] {
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Grep failed: invalid pattern: ${msg}`)
  }

  const results: string[] = []
  const rootStat = fs.statSync(searchRoot)

  if (rootStat.isFile()) {
    grepFile(searchRoot, regex, globFilter, ctx, results)
    return results
  }

  walk(searchRoot, regex, globFilter, ctx, results)
  return results
}

function walk(
  dir: string,
  regex: RegExp,
  globFilter: string | undefined,
  ctx: ToolContext,
  results: string[],
): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const ent of entries) {
    // Skip common heavy/irrelevant dirs
    if (ent.name === 'node_modules' || ent.name === '.git') continue
    const abs = path.join(dir, ent.name)
    try {
      assertInsideWorkspace(ctx.workspaceRoot, abs)
    } catch (err) {
      if (err instanceof PathEscapeError) continue
      throw err
    }
    if (ent.isDirectory()) {
      walk(abs, regex, globFilter, ctx, results)
    } else if (ent.isFile()) {
      grepFile(abs, regex, globFilter, ctx, results)
    }
  }
}

function grepFile(
  abs: string,
  regex: RegExp,
  globFilter: string | undefined,
  ctx: ToolContext,
  results: string[],
): void {
  let rel: string
  try {
    const safe = assertInsideWorkspace(ctx.workspaceRoot, abs)
    rel = toRelative(ctx.workspaceRoot, safe)
  } catch {
    return
  }

  if (globFilter && !matchGlob(globFilter, rel) && !matchGlob(globFilter, path.basename(rel))) {
    return
  }

  let content: string
  try {
    const buf = fs.readFileSync(abs)
    // Skip likely binary
    if (buf.includes(0)) return
    content = buf.toString('utf8')
  } catch {
    return
  }

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (regex.test(line)) {
      results.push(`${rel}:${i + 1}:${line}`)
    }
  }
}
