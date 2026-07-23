/**
 * Reconnect pending permission redelivery:
 * - session.open re-sends permission.request + snapshot.pendingPermission
 * - re-auth.hello re-sends pending permission.request after WS drop
 * - permission.respond on new socket resolves the original gate
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
import type { runAgentLoop } from '../anthropic/loop'

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
  timeoutMs = 8000,
): Promise<Envelope[]> {
  return new Promise((resolve, reject) => {
    const out: Envelope[] = []
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `timeout waiting for ${count} messages, got ${out.length}: ${out
            .map((e) => e.type)
            .join(',')}`,
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

function waitForType(
  ws: WebSocket,
  type: string,
  timeoutMs = 8000,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timeout waiting for type=${type}`))
    }, timeoutMs)

    function onMessage(data: WebSocket.RawData) {
      const raw = typeof data === 'string' ? data : data.toString('utf8')
      const env = parseEnvelope(raw)
      if (env.type === type) {
        cleanup()
        resolve(env)
      }
    }

    function cleanup() {
      clearTimeout(timer)
      ws.off('message', onMessage)
    }

    ws.on('message', onMessage)
  })
}

function sendJson(ws: WebSocket, env: Envelope): void {
  ws.send(JSON.stringify(env))
}

async function pairAndToken(
  port: number,
  pairingCode: string,
): Promise<{ ws: WebSocket; deviceToken: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await waitOpen(ws)
  sendJson(
    ws,
    createEnvelope('auth.pair', {
      code: pairingCode,
      deviceName: 'ReconnectTest',
    }),
  )
  const msgs = await collectMessages(ws, 2)
  const pairResult = msgs.find((m) => m.type === 'auth.pair_result')!
  const deviceToken = (pairResult.payload as { deviceToken: string }).deviceToken
  return { ws, deviceToken }
}

describe('reconnect pending permission', () => {
  let workspace: string
  let dataDir: string
  let server: StartServerResult
  let config: AgentConfig

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-reconn-ws-'))
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-reconn-data-'))

    config = {
      host: '127.0.0.1',
      port: 0,
      workspaceRoot: workspace,
      dataDir,
      defaultModel: 'claude-sonnet-4-20250514',
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      autoAllowReadTools: false,
      pairingCodeTtlMs: 600_000,
    }

    const mockLoop: typeof runAgentLoop = async (args) => {
      const requestId = 'perm-req-reconnect-1'
      const toolRunId = 'tool-run-reconnect-1'
      args.events.onStatus('awaiting_permission', {
        model: config.defaultModel,
        busy: true,
      })
      const decision = await args.events.onPermissionRequired({
        requestId,
        toolRunId,
        name: 'Bash',
        input: { command: 'echo hi' },
        risk: 'high',
      })
      // Expose for assertions if needed
      void decision
      args.events.onToolCompleted({
        toolRunId,
        status: decision === 'deny' ? 'denied' : 'ok',
        outputSummary: decision === 'deny' ? 'denied' : 'ok',
      })
      args.events.onStatus('idle', { model: config.defaultModel, busy: false })
    }

    server = await startServer(config, { runLoop: mockLoop })
  })

  afterEach(async () => {
    await server.close()
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('session.open snapshot includes pendingPermission and re-sends permission.request', async () => {
    const { ws, deviceToken } = await pairAndToken(
      server.port,
      server.pairingCode,
    )
    void deviceToken

    sendJson(ws, createEnvelope('session.create', { title: 'Reconn' }))
    const snap = await waitForType(ws, 'session.snapshot')
    const sessionId = (snap.payload as { sessionId: string }).sessionId

    // Drain any residual then chat.send → permission.request
    sendJson(
      ws,
      createEnvelope('chat.send', { sessionId, text: 'run bash' }, { sessionId }),
    )

    const perm = await waitForType(ws, 'permission.request')
    const permPayload = perm.payload as {
      requestId: string
      name: string
      risk: string
    }
    expect(permPayload.name).toBe('Bash')
    expect(permPayload.requestId).toBeTruthy()

    // session.open while still connected → snapshot + redelivered permission.request
    sendJson(ws, createEnvelope('session.open', { sessionId }, { sessionId }))

    const afterOpen: Envelope[] = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout after session.open')),
        5000,
      )
      const onMsg = (data: WebSocket.RawData) => {
        const raw = typeof data === 'string' ? data : data.toString('utf8')
        const env = parseEnvelope(raw)
        afterOpen.push(env)
        const hasSnap = afterOpen.some((e) => e.type === 'session.snapshot')
        const hasPerm = afterOpen.some((e) => e.type === 'permission.request')
        if (hasSnap && hasPerm) {
          clearTimeout(timer)
          ws.off('message', onMsg)
          resolve()
        }
      }
      ws.on('message', onMsg)
    })

    const openSnap = afterOpen.find((e) => e.type === 'session.snapshot')!
    const openSnapPayload = openSnap.payload as {
      pendingPermission: { requestId: string; name: string } | null
      status: { phase: string; busy: boolean }
    }
    expect(openSnapPayload.pendingPermission).not.toBeNull()
    expect(openSnapPayload.pendingPermission!.requestId).toBe(
      permPayload.requestId,
    )
    expect(openSnapPayload.pendingPermission!.name).toBe('Bash')
    expect(openSnapPayload.status.busy).toBe(true)

    const redelivered = afterOpen.find((e) => e.type === 'permission.request')!
    expect((redelivered.payload as { requestId: string }).requestId).toBe(
      permPayload.requestId,
    )

    // Resolve so loop can finish cleanly
    sendJson(
      ws,
      createEnvelope(
        'permission.respond',
        { requestId: permPayload.requestId, decision: 'deny' },
        { sessionId },
      ),
    )
    await waitForType(ws, 'tool.completed')

    ws.close()
  })

  it('re-auth.hello after disconnect re-sends pending permission.request; respond works', async () => {
    const { ws: ws1, deviceToken } = await pairAndToken(
      server.port,
      server.pairingCode,
    )

    sendJson(ws1, createEnvelope('session.create', { title: 'Drop' }))
    const snap = await waitForType(ws1, 'session.snapshot')
    const sessionId = (snap.payload as { sessionId: string }).sessionId

    sendJson(
      ws1,
      createEnvelope(
        'chat.send',
        { sessionId, text: 'need approval' },
        { sessionId },
      ),
    )
    const perm = await waitForType(ws1, 'permission.request')
    const requestId = (perm.payload as { requestId: string }).requestId
    expect(requestId).toBeTruthy()

    // Simulate mobile background WS drop while permission is pending
    ws1.close()
    await new Promise((r) => setTimeout(r, 50))

    // New socket + auth.hello (same device token)
    const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(ws2)

    const helloMsgs: Envelope[] = []
    const helloDone = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout waiting hello + permission redelivery')),
        5000,
      )
      const onMsg = (data: WebSocket.RawData) => {
        const raw = typeof data === 'string' ? data : data.toString('utf8')
        const env = parseEnvelope(raw)
        helloMsgs.push(env)
        const hasOk = helloMsgs.some((e) => e.type === 'auth.ok')
        const hasPerm = helloMsgs.some((e) => e.type === 'permission.request')
        if (hasOk && hasPerm) {
          clearTimeout(timer)
          ws2.off('message', onMsg)
          resolve()
        }
      }
      ws2.on('message', onMsg)
    })

    sendJson(
      ws2,
      createEnvelope('auth.hello', {
        deviceToken,
        clientVersion: '0.0.0-test',
      }),
    )
    await helloDone

    const redelivered = helloMsgs.find((e) => e.type === 'permission.request')!
    expect(redelivered.sessionId).toBe(sessionId)
    expect((redelivered.payload as { requestId: string }).requestId).toBe(
      requestId,
    )
    expect((redelivered.payload as { name: string }).name).toBe('Bash')

    // Respond on the new connection — gate must still resolve
    sendJson(
      ws2,
      createEnvelope(
        'permission.respond',
        { requestId, decision: 'allow_once' },
        { sessionId },
      ),
    )

    const completed = await waitForType(ws2, 'tool.completed')
    expect((completed.payload as { status: string }).status).toBe('ok')

    ws2.close()
  })

  it('session.open after reconnect includes pendingPermission in snapshot', async () => {
    const { ws: ws1, deviceToken } = await pairAndToken(
      server.port,
      server.pairingCode,
    )

    sendJson(ws1, createEnvelope('session.create', { title: 'OpenAfter' }))
    const snap = await waitForType(ws1, 'session.snapshot')
    const sessionId = (snap.payload as { sessionId: string }).sessionId

    sendJson(
      ws1,
      createEnvelope('chat.send', { sessionId, text: 'x' }, { sessionId }),
    )
    const perm = await waitForType(ws1, 'permission.request')
    const requestId = (perm.payload as { requestId: string }).requestId

    ws1.close()
    await new Promise((r) => setTimeout(r, 50))

    const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(ws2)

    // Consume auth.ok + redelivered permission.request from hello
    sendJson(
      ws2,
      createEnvelope('auth.hello', {
        deviceToken,
        clientVersion: '0.0.0-test',
      }),
    )
    await waitForType(ws2, 'auth.ok')
    // Drain redelivered permission if it arrives before open
    await new Promise((r) => setTimeout(r, 30))

    sendJson(ws2, createEnvelope('session.open', { sessionId }, { sessionId }))

    const openSnap = await waitForType(ws2, 'session.snapshot')
    const payload = openSnap.payload as {
      pendingPermission: { requestId: string } | null
    }
    expect(payload.pendingPermission).not.toBeNull()
    expect(payload.pendingPermission!.requestId).toBe(requestId)

    sendJson(
      ws2,
      createEnvelope(
        'permission.respond',
        { requestId, decision: 'deny' },
        { sessionId },
      ),
    )
    await waitForType(ws2, 'tool.completed')
    ws2.close()
  })
})
