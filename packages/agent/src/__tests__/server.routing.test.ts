/**
 * WebSocket routing tests (no Anthropic API key required).
 * Covers auth.pair / auth.hello / unauthorized gate / session.list|create.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import {
  createEnvelope,
  parseEnvelope,
  type Envelope,
} from '@mobile-claude/protocol'
import type { AgentConfig } from '../config'
import { startServer, type StartServerResult } from '../server'

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve()
      return
    }
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 5000,
): Promise<Envelope[]> {
  return new Promise((resolve, reject) => {
    const out: Envelope[] = []
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `timeout waiting for ${count} messages, got ${out.length}: ${out.map((e) => e.type).join(',')}`,
        ),
      )
    }, timeoutMs)

    function onMessage(data: WebSocket.RawData) {
      const raw = typeof data === 'string' ? data : data.toString('utf8')
      out.push(parseEnvelope(raw))
      if (out.length >= count) {
        cleanup()
        resolve(out)
      }
    }

    function cleanup() {
      clearTimeout(timer)
      ws.off('message', onMessage)
    }

    ws.on('message', onMessage)
  })
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<Envelope> {
  return collectMessages(ws, 1, timeoutMs).then((m) => m[0]!)
}

function sendJson(ws: WebSocket, env: Envelope): void {
  ws.send(JSON.stringify(env))
}

describe('WebSocket server routing', () => {
  let workspace: string
  let dataDir: string
  let server: StartServerResult
  let config: AgentConfig

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ws-'))
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-data-'))
    fs.writeFileSync(path.join(workspace, 'hello.txt'), 'hi from workspace\n')

    config = {
      host: '127.0.0.1',
      port: 0,
      workspaceRoot: workspace,
      dataDir,
      defaultModel: 'claude-sonnet-4-20250514',
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      autoAllowReadTools: true,
      pairingCodeTtlMs: 600_000,
    }

    server = await startServer(config)
  })

  afterEach(async () => {
    await server.close()
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('rejects non-auth messages before hello/pair with unauthorized', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(ws)

    sendJson(ws, createEnvelope('session.list', {}))
    const err = await nextMessage(ws)
    expect(err.type).toBe('error')
    expect((err.payload as { code: string }).code).toBe('unauthorized')

    ws.close()
  })

  it('pairs with code and returns auth.pair_result + auth.ok', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(ws)

    sendJson(
      ws,
      createEnvelope('auth.pair', {
        code: server.pairingCode,
        deviceName: 'Test Phone',
      }),
    )

    const msgs = await collectMessages(ws, 2)
    const types = msgs.map((m) => m.type).sort()
    expect(types).toEqual(['auth.ok', 'auth.pair_result'])

    const pairResult = msgs.find((m) => m.type === 'auth.pair_result')!
    const ok = msgs.find((m) => m.type === 'auth.ok')!
    const pr = pairResult.payload as {
      deviceToken: string
      deviceId: string
    }
    const authOk = ok.payload as {
      deviceId: string
      workspaceRoot: string
      serverVersion: string
    }

    expect(pr.deviceToken.length).toBeGreaterThan(20)
    expect(pr.deviceId).toBe(authOk.deviceId)
    expect(authOk.workspaceRoot).toBe(workspace)
    expect(authOk.serverVersion).toBeTruthy()

    ws.close()
  })

  it('auth.hello with token then session.list returns empty list', async () => {
    // Pair on connection A to get token
    const wsPair = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(wsPair)
    sendJson(
      wsPair,
      createEnvelope('auth.pair', {
        code: server.pairingCode,
        deviceName: 'Device',
      }),
    )
    const pairMsgs = await collectMessages(wsPair, 2)
    const pairResult = pairMsgs.find((m) => m.type === 'auth.pair_result')!
    const deviceToken = (pairResult.payload as { deviceToken: string }).deviceToken
    wsPair.close()

    // New connection with hello
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(ws)

    sendJson(
      ws,
      createEnvelope('auth.hello', {
        deviceToken,
        clientVersion: '0.0.0-test',
      }),
    )
    const hello = await nextMessage(ws)
    expect(hello.type).toBe('auth.ok')

    sendJson(ws, createEnvelope('session.list', {}))
    const list = await nextMessage(ws)
    expect(list.type).toBe('session.list_result')
    expect((list.payload as { sessions: unknown[] }).sessions).toEqual([])

    ws.close()
  })

  it('session.create then session.list returns the session', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(ws)

    sendJson(
      ws,
      createEnvelope('auth.pair', {
        code: server.pairingCode,
        deviceName: 'Dev',
      }),
    )
    await collectMessages(ws, 2)

    sendJson(
      ws,
      createEnvelope('session.create', { title: 'My Session' }),
    )
    const snap = await nextMessage(ws)
    expect(snap.type).toBe('session.snapshot')
    const snapPayload = snap.payload as {
      sessionId: string
      title: string
      messages: unknown[]
      status: { phase: string; busy: boolean }
    }
    expect(snapPayload.title).toBe('My Session')
    expect(snapPayload.messages).toEqual([])
    expect(snapPayload.status.phase).toBe('idle')
    expect(snapPayload.status.busy).toBe(false)

    sendJson(ws, createEnvelope('session.list', {}))
    const list = await nextMessage(ws)
    expect(list.type).toBe('session.list_result')
    const sessions = (list.payload as { sessions: Array<{ id: string; title: string }> })
      .sessions
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.id).toBe(snapPayload.sessionId)
    expect(sessions[0]!.title).toBe('My Session')

    ws.close()
  })

  it('rejects bad pairing code with unauthorized', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(ws)

    sendJson(
      ws,
      createEnvelope('auth.pair', {
        code: 'XXXXXX',
        deviceName: 'Nope',
      }),
    )
    const err = await nextMessage(ws)
    expect(err.type).toBe('error')
    expect((err.payload as { code: string }).code).toBe('unauthorized')

    // Still unauthenticated
    sendJson(ws, createEnvelope('session.list', {}))
    const err2 = await nextMessage(ws)
    expect((err2.payload as { code: string }).code).toBe('unauthorized')

    ws.close()
  })

  it('config.get never returns an API key field', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(ws)

    sendJson(
      ws,
      createEnvelope('auth.pair', {
        code: server.pairingCode,
        deviceName: 'Cfg',
      }),
    )
    await collectMessages(ws, 2)

    sendJson(ws, createEnvelope('config.get', {}))
    const cfg = await nextMessage(ws)
    expect(cfg.type).toBe('config')
    const p = cfg.payload as Record<string, unknown>
    expect(p).not.toHaveProperty('apiKey')
    expect(p).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(p).not.toHaveProperty('anthropicApiKey')
    expect(typeof p.model).toBe('string')
    expect(typeof p.autoAllowReadTools).toBe('boolean')
    expect(typeof p.hasApiKey).toBe('boolean')

    // Attempt to set api key is rejected
    sendJson(
      ws,
      createEnvelope('config.set', {
        model: 'claude-sonnet-4-20250514',
        apiKey: 'sk-evil',
      } as unknown as { model: string }),
    )
    const rejected = await nextMessage(ws)
    expect(rejected.type).toBe('error')
    expect((rejected.payload as { code: string }).code).toBe('forbidden')

    ws.close()
  })

  it('fs.list returns workspace entries after auth', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(ws)

    sendJson(
      ws,
      createEnvelope('auth.pair', {
        code: server.pairingCode,
        deviceName: 'Fs',
      }),
    )
    await collectMessages(ws, 2)

    sendJson(ws, createEnvelope('fs.list', { path: '.' }))
    const list = await nextMessage(ws)
    expect(list.type).toBe('fs.list_result')
    const payload = list.payload as {
      entries: Array<{ name: string; type: string }>
    }
    expect(payload.entries.some((e) => e.name === 'hello.txt')).toBe(true)

    sendJson(
      ws,
      createEnvelope('fs.read', { path: 'hello.txt', maxBytes: 1000 }),
    )
    const read = await nextMessage(ws)
    expect(read.type).toBe('fs.read_result')
    expect((read.payload as { content: string }).content).toContain('hi from workspace')

    ws.close()
  })
})
