import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PathEscapeError } from '../paths'
import { buildShellEnv, spawnCollect } from '../tools/bash'
import { truncateOutput, truncateText } from '../tools/input'
import { runTool, anthropicToolDefinitions } from '../tools/registry'
import type { ToolContext } from '../tools/types'
import { MAX_READ_BYTES, MAX_TOOL_OUTPUT_CHARS } from '../tools/types'

function makeCtx(workspaceRoot: string, shell: ToolContext['shell'] = 'powershell'): ToolContext {
  return { workspaceRoot, shell }
}

describe('tools sandbox', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tools-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('Write + Read round trip', async () => {
    const ctx = makeCtx(root)
    const written = await runTool(
      'Write',
      { path: 'hello.txt', content: 'hello world' },
      ctx,
    )
    expect(written.output).toMatch(/hello\.txt/)
    expect(written.diff).toBeDefined()
    expect(written.diff?.after).toBe('hello world')

    const read = await runTool('Read', { path: 'hello.txt' }, ctx)
    expect(read.output).toBe('hello world')
    expect(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8')).toBe('hello world')
  })

  it('Edit replaces once; missing old_string throws', async () => {
    const ctx = makeCtx(root)
    fs.writeFileSync(path.join(root, 'edit-me.txt'), 'aaa bbb aaa')

    const edited = await runTool(
      'Edit',
      { path: 'edit-me.txt', old_string: 'aaa', new_string: 'XXX' },
      ctx,
    )
    expect(edited.diff).toBeDefined()
    expect(edited.diff?.after).toBe('XXX bbb aaa')
    expect(fs.readFileSync(path.join(root, 'edit-me.txt'), 'utf8')).toBe('XXX bbb aaa')

    await expect(
      runTool(
        'Edit',
        { path: 'edit-me.txt', old_string: 'not-present', new_string: 'y' },
        ctx,
      ),
    ).rejects.toThrow(/old_string/)
  })

  it('Read of path escape throws PathEscapeError', async () => {
    const ctx = makeCtx(root)
    await expect(runTool('Read', { path: '../etc/passwd' }, ctx)).rejects.toThrow(
      PathEscapeError,
    )
  })

  it('Bash echo hi returns stdout', async () => {
    const shell: ToolContext['shell'] =
      process.platform === 'win32' ? 'powershell' : 'bash'
    const ctx = makeCtx(root, shell)
    const command = shell === 'powershell' ? 'Write-Output hi' : 'echo hi'
    const result = await runTool('Bash', { command }, ctx)
    expect(result.output).toMatch(/hi/)
  })

  it('Bash cwd escape denied', async () => {
    const shell: ToolContext['shell'] =
      process.platform === 'win32' ? 'powershell' : 'bash'
    const ctx = makeCtx(root, shell)
    const command = shell === 'powershell' ? 'Write-Output hi' : 'echo hi'
    await expect(
      runTool('Bash', { command, cwd: '..' }, ctx),
    ).rejects.toThrow(PathEscapeError)
  })

  it('Read supports offset and limit (1-indexed lines)', async () => {
    const ctx = makeCtx(root)
    fs.writeFileSync(path.join(root, 'lines.txt'), 'L1\nL2\nL3\nL4\n')
    const result = await runTool('Read', { path: 'lines.txt', offset: 2, limit: 2 }, ctx)
    expect(result.output).toBe('L2\nL3')
  })

  it('Glob finds files under workspace', async () => {
    const ctx = makeCtx(root)
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'a')
    fs.writeFileSync(path.join(root, 'src', 'b.js'), 'b')
    fs.writeFileSync(path.join(root, 'c.ts'), 'c')

    const result = await runTool('Glob', { pattern: '**/*.ts' }, ctx)
    const lines = result.output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(lines).toContain('c.ts')
    expect(lines).toContain('src/a.ts')
    expect(lines).not.toContain('src/b.js')
  })

  it('Grep finds matching lines', async () => {
    const ctx = makeCtx(root)
    fs.writeFileSync(path.join(root, 'g1.txt'), 'alpha\nbeta findme\ngamma')
    fs.writeFileSync(path.join(root, 'g2.txt'), 'nope')

    const result = await runTool('Grep', { pattern: 'findme' }, ctx)
    expect(result.output).toMatch(/g1\.txt/)
    expect(result.output).toMatch(/findme/)
    expect(result.output).not.toMatch(/g2\.txt/)
  })

  it('unknown tool throws', async () => {
    await expect(runTool('NoSuch', {}, makeCtx(root))).rejects.toThrow(/unknown tool/i)
  })

  it('anthropicToolDefinitions lists six tools', () => {
    const defs = anthropicToolDefinitions()
    const names = defs.map((d) => d.name).sort()
    expect(names).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'])
    for (const d of defs) {
      expect(d.input_schema.type).toBe('object')
      expect(d.input_schema.properties).toBeDefined()
    }
  })

  it('truncateOutput caps at maxChars with suffix', () => {
    const max = 20
    const text = 'abcdefghijklmnopqrstuvwxyz'
    const out = truncateOutput(text, max)
    expect(out.endsWith('\n[truncated]')).toBe(true)
    expect(out.length).toBe(max)
    // keep = max - '\n[truncated]'.length = 8
    expect(out).toBe('abcdefgh\n[truncated]')
    expect(truncateOutput('short', 100)).toBe('short')
  })

  it('truncateText sets truncated flag when capped', () => {
    const capped = truncateText('abcdefghijklmnopqrstuvwxyz', 20)
    expect(capped.truncated).toBe(true)
    expect(capped.text.endsWith('\n[truncated]')).toBe(true)
    expect(truncateText('short', 100)).toEqual({
      text: 'short',
      truncated: false,
    })
  })

  it('Read tool result sets truncated when content exceeds max', async () => {
    const ctx = makeCtx(root)
    const bigPath = path.join(root, 'big.txt')
    // Under MAX_READ_BYTES (1_000_000) but over MAX_TOOL_OUTPUT_CHARS (200_000)
    const size = Math.min(MAX_TOOL_OUTPUT_CHARS + 50_000, 900_000)
    fs.writeFileSync(bigPath, 'x'.repeat(size))
    const result = await runTool('Read', { path: 'big.txt' }, ctx)
    expect(result.truncated).toBe(true)
    expect(result.output.endsWith('\n[truncated]')).toBe(true)
    expect(result.output.length).toBe(MAX_TOOL_OUTPUT_CHARS)
  })

  it('spawnCollect times out and kills process (injectable short timeout)', async () => {
    const isWin = process.platform === 'win32'
    const executable = isWin ? 'powershell.exe' : 'bash'
    const args = isWin
      ? ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30']
      : ['-c', 'sleep 30']

    // Use os.tmpdir() so a lagging kill cannot lock the test workspace root
    const started = Date.now()
    await expect(
      spawnCollect({
        executable,
        args,
        cwd: os.tmpdir(),
        timeoutMs: 400,
        maxOutputChars: 1024,
      }),
    ).rejects.toThrow(/timed out after 400ms/)
    const elapsed = Date.now() - started
    // Should not wait for the full 30s sleep
    expect(elapsed).toBeLessThan(15_000)
  }, 20_000)

  it('buildShellEnv strips ANTHROPIC_API_KEY and secret-like keys', () => {
    const scrubbed = buildShellEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      ANTHROPIC_API_KEY: 'sk-secret-should-not-leak',
      MY_API_KEY: 'also-secret',
      OAUTH_TOKEN: 'tok',
      DB_PASSWORD: 'pw',
      AWS_SECRET_ACCESS_KEY: 'aws',
      CREDENTIAL_FILE: '/tmp/creds',
      LANG: 'en_US.UTF-8',
      TEMP: '/tmp',
      LEAKY_CUSTOM: 'should-not-pass',
    })
    expect(scrubbed.PATH).toBe('/usr/bin')
    expect(scrubbed.HOME).toBe('/home/u')
    expect(scrubbed.LANG).toBe('en_US.UTF-8')
    expect(scrubbed.TEMP).toBe('/tmp')
    expect(scrubbed).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(scrubbed).not.toHaveProperty('MY_API_KEY')
    expect(scrubbed).not.toHaveProperty('OAUTH_TOKEN')
    expect(scrubbed).not.toHaveProperty('DB_PASSWORD')
    expect(scrubbed).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(scrubbed).not.toHaveProperty('CREDENTIAL_FILE')
    expect(scrubbed).not.toHaveProperty('LEAKY_CUSTOM')
  })

  it('spawnCollect does not expose ANTHROPIC_API_KEY to the child env', async () => {
    const isWin = process.platform === 'win32'
    const marker = 'ANTHROPIC_API_KEY_VALUE='
    // Force a source env that contains the secret; buildShellEnv must strip it
    const polluted: NodeJS.ProcessEnv = {
      ...buildShellEnv(),
      PATH: process.env.PATH ?? process.env.Path,
      Path: process.env.Path ?? process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      COMSPEC: process.env.COMSPEC,
      // Intentionally inject secret into opts.env override path via buildShellEnv only
    }
    // Verify buildShellEnv used by default path
    const env = buildShellEnv({
      ...polluted,
      ANTHROPIC_API_KEY: 'sk-must-not-appear-in-child',
      HOME: process.env.HOME ?? process.env.USERPROFILE,
      USERPROFILE: process.env.USERPROFILE,
      TEMP: process.env.TEMP ?? os.tmpdir(),
      TMP: process.env.TMP ?? os.tmpdir(),
    })
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')

    const executable = isWin ? 'powershell.exe' : 'bash'
    const args = isWin
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Write-Output ("${marker}" + $env:ANTHROPIC_API_KEY)`,
        ]
      : ['-c', `printf '%s' "${marker}$ANTHROPIC_API_KEY"`]

    const out = await spawnCollect({
      executable,
      args,
      cwd: os.tmpdir(),
      timeoutMs: 10_000,
      maxOutputChars: 1024,
      env,
    })
    expect(out).not.toContain('sk-must-not-appear-in-child')
    // Child may print empty value; must not print the secret
    expect(out).toMatch(new RegExp(`${marker}(\\s|$)`))
  }, 15_000)

  it('Write path escape denied', async () => {
    const ctx = makeCtx(root)
    await expect(
      runTool('Write', { path: '../escape.txt', content: 'x' }, ctx),
    ).rejects.toThrow(PathEscapeError)
  })

  it('Edit path escape denied', async () => {
    const ctx = makeCtx(root)
    await expect(
      runTool(
        'Edit',
        { path: '../escape.txt', old_string: 'a', new_string: 'b' },
        ctx,
      ),
    ).rejects.toThrow(PathEscapeError)
  })

  it('Edit rejects oversized file before full read', async () => {
    const ctx = makeCtx(root)
    const big = path.join(root, 'huge.bin')
    // Create sparse-ish file just over MAX_READ_BYTES without filling memory with content in JS
    const fd = fs.openSync(big, 'w')
    try {
      fs.ftruncateSync(fd, MAX_READ_BYTES + 1)
    } finally {
      fs.closeSync(fd)
    }
    await expect(
      runTool(
        'Edit',
        { path: 'huge.bin', old_string: 'a', new_string: 'b' },
        ctx,
      ),
    ).rejects.toThrow(/exceeds max size/)
  })
})

