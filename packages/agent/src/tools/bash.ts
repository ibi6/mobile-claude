import {
  execFileSync,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assertInsideWorkspace } from '../paths.js'
import { asRecord, optionalString, requireString, truncateText } from './input.js'
import {
  BASH_TIMEOUT_MS,
  MAX_TOOL_OUTPUT_CHARS,
  type ToolContext,
  type ToolResult,
} from './types.js'

export async function runBash(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const obj = asRecord(input)
  const command = requireString(obj, 'command')
  if (!command.trim()) {
    throw new Error('Bash failed: command must not be empty')
  }
  const cwdOpt = optionalString(obj, 'cwd')

  const workspaceReal = fs.realpathSync(ctx.workspaceRoot)
  let cwd: string
  if (cwdOpt === undefined || cwdOpt === '') {
    cwd = workspaceReal
  } else {
    // Relative cwd is resolved against workspace root
    const candidate = path.isAbsolute(cwdOpt)
      ? cwdOpt
      : path.resolve(workspaceReal, cwdOpt)
    cwd = assertInsideWorkspace(ctx.workspaceRoot, candidate)
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Bash failed: cwd is not a directory: ${cwdOpt}`)
    }
  }

  const { executable, args } = shellInvocation(ctx.shell, command)

  const output = await spawnCollect({
    executable,
    args,
    cwd,
    signal: ctx.signal,
    timeoutMs: BASH_TIMEOUT_MS,
    maxOutputChars: MAX_TOOL_OUTPUT_CHARS,
  })

  const capped = truncateText(output, MAX_TOOL_OUTPUT_CHARS)
  return {
    output: capped.text,
    ...(capped.truncated ? { truncated: true } : {}),
  }
}

function shellInvocation(
  shell: ToolContext['shell'],
  command: string,
): { executable: string; args: string[] } {
  switch (shell) {
    case 'powershell':
      return {
        executable: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-Command', command],
      }
    case 'cmd':
      return {
        executable: process.platform === 'win32' ? 'cmd.exe' : 'cmd',
        args: ['/d', '/s', '/c', command],
      }
    case 'bash':
    default:
      return {
        executable: 'bash',
        args: ['-c', command],
      }
  }
}

export type SpawnCollectArgs = {
  executable: string
  args: string[]
  cwd: string
  signal?: AbortSignal
  timeoutMs: number
  /** Cap collected stdout/stderr growth (chars). Defaults to MAX_TOOL_OUTPUT_CHARS. */
  maxOutputChars?: number
  /** Override env (defaults to buildShellEnv()). Useful for tests. */
  env?: NodeJS.ProcessEnv
}

/** Keys required for a working shell on Windows / Unix. */
const SHELL_ENV_ALLOW = new Set([
  'PATH',
  'Path', // Windows may use either casing
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'WINDIR',
  'COMSPEC',
  'ComSpec',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'SHELL',
  'USER',
  'USERNAME',
  'LOGNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'PWD',
])

/** Strip secrets / API keys from child process environment. */
const SECRET_ENV_RE = /SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL/i

/**
 * Build a minimal env for shell tool children.
 * Does NOT pass full process.env — strips ANTHROPIC_API_KEY and other secrets.
 */
export function buildShellEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (SECRET_ENV_RE.test(key)) continue
    if (key === 'ANTHROPIC_API_KEY') continue
    if (SHELL_ENV_ALLOW.has(key)) {
      out[key] = value
    }
  }
  // Ensure PATH exists if present under either casing
  if (!out.PATH && !out.Path && source.PATH) {
    out.PATH = source.PATH
  }
  return out
}

/**
 * Kill a child and its process tree.
 * Windows: `taskkill /pid <pid> /T /F` then force `child.kill()`.
 * Unix: SIGKILL on the child (and process group when possible).
 */
export function killChildProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return

  if (process.platform === 'win32') {
    try {
      // Sync so the tree is gone before we settle (avoids locked cwd on Windows)
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      // fall through to force kill
    }
    try {
      child.kill()
    } catch {
      // ignore
    }
    return
  }

  try {
    // Negative PID = process group (only works if child started in its own group)
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }
}

/** Append chunk into buf, never growing past maxChars. */
function appendCapped(buf: string, chunk: string, maxChars: number): string {
  if (buf.length >= maxChars) return buf
  const room = maxChars - buf.length
  if (chunk.length <= room) return buf + chunk
  return buf + chunk.slice(0, room)
}

/**
 * Spawn a process and collect stdout/stderr with timeout, abort, and memory bounds.
 * Exported for short-timeout kill tests.
 */
export function spawnCollect(opts: SpawnCollectArgs): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('Bash aborted'))
      return
    }

    const maxChars = opts.maxOutputChars ?? MAX_TOOL_OUTPUT_CHARS

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(opts.executable, opts.args, {
        cwd: opts.cwd,
        env: opts.env ?? buildShellEnv(),
        windowsHide: true,
        // Do NOT use shell:true — command is a single argv element to -Command / -c /c
      }) as ChildProcessWithoutNullStreams
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      reject(new Error(`Bash failed to start: ${msg}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const destroyStreams = () => {
      try {
        child.stdout.destroy()
      } catch {
        // ignore
      }
      try {
        child.stderr.destroy()
      } catch {
        // ignore
      }
      try {
        child.stdin.destroy()
      } catch {
        // ignore
      }
    }

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      destroyStreams()
      fn()
    }

    const onAbort = () => {
      killChildProcessTree(child)
      finish(() => reject(new Error('Bash aborted')))
    }

    const timer = setTimeout(() => {
      killChildProcessTree(child)
      finish(() =>
        reject(new Error(`Bash timed out after ${opts.timeoutMs}ms`)),
      )
    }, opts.timeoutMs)

    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk, maxChars)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk, maxChars)
    })

    child.on('error', (err) => {
      finish(() => reject(new Error(`Bash failed: ${err.message}`)))
    })

    child.on('close', (code, signal) => {
      const parts: string[] = []
      if (stdout) parts.push(stdout)
      if (stderr) parts.push(stderr)
      let combined = parts.join(stdout && stderr ? '\n' : '')
      // Normalize CRLF for cross-platform assertions
      combined = combined.replace(/\r\n/g, '\n')

      if (signal) {
        finish(() =>
          reject(new Error(`Bash killed by signal ${signal}\n${combined}`)),
        )
        return
      }

      if (code !== 0 && code !== null) {
        // Non-zero still returns output so the model can see errors
        finish(() =>
          resolve(
            combined.trim().length > 0
              ? `${combined}${combined.endsWith('\n') ? '' : '\n'}[exit ${code}]`
              : `[exit ${code}]`,
          ),
        )
        return
      }

      finish(() => resolve(combined))
    })
  })
}
