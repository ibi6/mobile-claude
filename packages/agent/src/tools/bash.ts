import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assertInsideWorkspace } from '../paths.js'
import { asRecord, optionalString, requireString, truncateOutput } from './input.js'
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
  })

  return { output: truncateOutput(output, MAX_TOOL_OUTPUT_CHARS) }
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

type SpawnCollectArgs = {
  executable: string
  args: string[]
  cwd: string
  signal?: AbortSignal
  timeoutMs: number
}

function spawnCollect(opts: SpawnCollectArgs): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('Bash aborted'))
      return
    }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(opts.executable, opts.args, {
        cwd: opts.cwd,
        env: process.env,
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

    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      finish(() => reject(new Error('Bash aborted')))
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      finish(() =>
        reject(new Error(`Bash timed out after ${opts.timeoutMs}ms`)),
      )
    }, opts.timeoutMs)

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
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
