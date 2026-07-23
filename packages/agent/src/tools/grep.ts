import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assertInsideWorkspace, toRelative, PathEscapeError } from '../paths.js'
import { matchGlob } from './glob.js'
import { asRecord, optionalString, requireString, truncateText } from './input.js'
import {
  MAX_READ_BYTES,
  MAX_TOOL_OUTPUT_CHARS,
  type ToolContext,
  type ToolResult,
} from './types.js'

/** Ripgrep process timeout (ms). */
export const GREP_TIMEOUT_MS = 60_000

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

  if (ctx.signal?.aborted) {
    throw new Error('Grep aborted')
  }

  const rgOut = await tryRipgrep(pattern, searchRoot, globFilter, ctx)
  if (rgOut !== null) {
    const capped = truncateText(rgOut, MAX_TOOL_OUTPUT_CHARS)
    return {
      output: capped.text,
      ...(capped.truncated ? { truncated: true } : {}),
    }
  }

  if (ctx.signal?.aborted) {
    throw new Error('Grep aborted')
  }

  const lines = tsGrep(pattern, searchRoot, globFilter, ctx)
  const capped = truncateText(lines.join('\n'), MAX_TOOL_OUTPUT_CHARS)
  return {
    output: capped.text,
    ...(capped.truncated ? { truncated: true } : {}),
  }
}

function killRg(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.unref()
    } catch {
      // fall through
    }
    try {
      child.kill()
    } catch {
      // ignore
    }
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // ignore
  }
}

function appendCapped(buf: string, chunk: string, maxChars: number): string {
  if (buf.length >= maxChars) return buf
  const room = maxChars - buf.length
  if (chunk.length <= room) return buf + chunk
  return buf + chunk.slice(0, room)
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
    let child: ChildProcess | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    const onAbort = () => {
      if (child) killRg(child)
      finish(null)
    }

    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onAbort)
      if (child) {
        try {
          child.stdout?.destroy()
        } catch {
          // ignore
        }
        try {
          child.stderr?.destroy()
        } catch {
          // ignore
        }
      }
      resolve(value)
    }

    try {
      child = spawn('rg', args, {
        cwd: ctx.workspaceRoot,
        windowsHide: true,
      })
    } catch {
      finish(null)
      return
    }

    timer = setTimeout(() => {
      if (child) killRg(child)
      // Timed out — fall back to TS grep rather than hang forever
      finish(null)
    }, GREP_TIMEOUT_MS)

    if (ctx.signal?.aborted) {
      killRg(child)
      finish(null)
      return
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk, MAX_TOOL_OUTPUT_CHARS)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk, MAX_TOOL_OUTPUT_CHARS)
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      // rg: 0 matches, 1 no matches, 2 error
      if (code === 0 || code === 1) {
        // Rewrite absolute paths to workspace-relative; discard escapes
        const normalized = stdout
          .split('\n')
          .filter((l) => l.length > 0)
          .map((line) => relativizeRgLine(line, ctx))
          .filter((line): line is string => line !== null)
          .join('\n')
        finish(normalized)
        return
      }
      void stderr
      finish(null)
    })
  })
}

/**
 * Parse an rg line and rewrite path to workspace-relative.
 * Returns null if the path escapes the workspace (discard, do not leak absolute path).
 */
function relativizeRgLine(line: string, ctx: ToolContext): string | null {
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
    // Outside workspace — discard instead of returning raw escaped path
    return null
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

function resultsFull(results: string[]): boolean {
  return results.join('\n').length >= MAX_TOOL_OUTPUT_CHARS
}

function walk(
  dir: string,
  regex: RegExp,
  globFilter: string | undefined,
  ctx: ToolContext,
  results: string[],
): void {
  if (resultsFull(results) || ctx.signal?.aborted) return

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const ent of entries) {
    if (resultsFull(results) || ctx.signal?.aborted) return
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
  if (resultsFull(results) || ctx.signal?.aborted) return

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
    const stat = fs.statSync(abs)
    // Skip huge files (align with Read limit)
    if (stat.size > MAX_READ_BYTES) return
    const buf = fs.readFileSync(abs)
    // Skip likely binary
    if (buf.includes(0)) return
    content = buf.toString('utf8')
  } catch {
    return
  }

  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (resultsFull(results)) return
    const line = lines[i]!
    if (regex.test(line)) {
      results.push(`${rel}:${i + 1}:${line}`)
    }
  }
}
