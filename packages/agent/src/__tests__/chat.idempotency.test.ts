/**
 * Spec §4.4: chat.send with duplicate client envelope `id` within 5 minutes
 * is ignored if already accepted.
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
  timeoutMs = 5000,
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
  timeoutMs = 5000,
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

describe('chat.send idempotency', () => {
  let workspace: string
  let dataDir: string
  let server: StartServerResult
  let loopCalls: number
  let releaseTurn: (() => void) | null
  let turnGate: Promise<void>

  beforeEach(async () => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-idem-ws-'))
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-idem-data-'))
    loopCalls = 0
    releaseTurn = null
    turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })

    const config: AgentConfig = {
      host: '127.0.0.1',
      port: 0,
      workspaceRoot: workspace,
      dataDir,
      defaultModel: 'claude-sonnet-4-20250514',
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      autoAllowReadTools: true,
      pairingCodeTtlMs: 600_000,
    }

    const mockLoop: typeof runAgentLoop = async (args) => {
      loopCalls += 1
      args.events.onStatus('thinking', {
        model: config.defaultModel,
        busy: true,
      })
      await turnGate
      args.events.onMessageCompleted({
        messageId: 'msg-idem-1',
        stopReason: 'end_turn',
      })
      args.events.onStatus('idle', {
        model: config.defaultModel,
        busy: false,
      })
    }

    server = await startServer(config, { runLoop: mockLoop })
  })

  afterEach(async () => {
    releaseTurn?.()
    await server.close()
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  async function pairAndCreateSession(): Promise<{
    ws: WebSocket
    sessionId: string
  }> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await waitOpen(ws)
    sendJson(
      ws,
      createEnvelope('auth.pair', {
        code: server.pairingCode,
        deviceName: 'IdemPhone',
      }),
    )
    await collectMessages(ws, 2)

    sendJson(ws, createEnvelope('session.create', { title: 'Idem' }))
    const snap = await waitForType(ws, 'session.snapshot')
    const sessionId = (snap.payload as { sessionId: string }).sessionId
    return { ws, sessionId }
  }

  it('duplicate envelope id within window does not re-run the agent loop', async () => {
    const { ws, sessionId } = await pairAndCreateSession()

    const env = createEnvelope(
      'chat.send',
      { sessionId, text: 'hello once' },
      { sessionId },
    )

    sendJson(ws, env)
    await waitForType(ws, 'status')

    // Same id again while turn is in flight
    sendJson(ws, env)
    await new Promise((r) => setTimeout(r, 80))
    expect(loopCalls).toBe(1)

    // Different id while busy → busy error (proves server still routing)
    sendJson(
      ws,
      createEnvelope(
        'chat.send',
        { sessionId, text: 'second turn' },
        { sessionId },
      ),
    )
    const busyErr = await waitForType(ws, 'error')
    expect((busyErr.payload as { code: string }).code).toBe('busy')
    expect(loopCalls).toBe(1)

    // Finish turn
    releaseTurn?.()
    await waitForType(ws, 'message.completed')

    // Same original id after completion still ignored (within 5 min)
    sendJson(ws, env)
    await new Promise((r) => setTimeout(r, 80))
    expect(loopCalls).toBe(1)

    // Fresh id starts a new turn
    turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    sendJson(
      ws,
      createEnvelope(
        'chat.send',
        { sessionId, text: 'fresh id' },
        { sessionId },
      ),
    )
    await waitForType(ws, 'status')
    expect(loopCalls).toBe(2)
    releaseTurn?.()
    await waitForType(ws, 'message.completed')

    ws.close()
  })

  it('failed chat.send (not_found) is not locked by idempotency', async () => {
    const { ws } = await pairAndCreateSession()

    const env = createEnvelope('chat.send', {
      sessionId: 'missing-session-id',
      text: 'nope',
    })
    sendJson(ws, env)
    const err = await waitForType(ws, 'error')
    expect((err.payload as { code: string }).code).toBe('not_found')
    expect(loopCalls).toBe(0)

    // Same id with a real session should still be accepted
    sendJson(ws, createEnvelope('session.create', { title: 'Other' }))
    const snap = await waitForType(ws, 'session.snapshot')
    const sessionId = (snap.payload as { sessionId: string }).sessionId

    const retry = createEnvelope(
      'chat.send',
      { sessionId, text: 'ok now' },
      { id: env.id, sessionId },
    )
    sendJson(ws, retry)
    await waitForType(ws, 'status')
    expect(loopCalls).toBe(1)
    releaseTurn?.()
    await waitForType(ws, 'message.completed')

    ws.close()
  })
})
