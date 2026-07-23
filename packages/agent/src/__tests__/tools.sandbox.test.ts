import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PathEscapeError } from '../paths'
import { spawnCollect } from '../tools/bash'
import { truncateOutput } from '../tools/input'
import { runTool, anthropicToolDefinitions } from '../tools/registry'
import type { ToolContext } from '../tools/types'
import { MAX_READ_BYTES } from '../tools/types'

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

