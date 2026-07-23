/**
 * WebSocket agent daemon: auth, sessions, chat loop, fs, config.
 * API key is never accepted over the wire — only process.env.ANTHROPIC_API_KEY.
 */

import type { AddressInfo } from 'node:net'
import { WebSocketServer, WebSocket } from 'ws'
import {
  createEnvelope,
  parseEnvelope,
  ProtocolError,
  AuthPairPayloadSchema,
  AuthHelloPayloadSchema,
  SessionListPayloadSchema,
  SessionCreatePayloadSchema,
  SessionOpenPayloadSchema,
  SessionDeletePayloadSchema,
  ChatSendPayloadSchema,
  ChatAbortPayloadSchema,
  SlashRunPayloadSchema,
  PermissionRespondPayloadSchema,
  FsListPayloadSchema,
  FsReadPayloadSchema,
  ConfigGetPayloadSchema,
  ConfigSetPayloadSchema,
  type Envelope,
  type ErrorCode,
  type ErrorPayload,
  type PermissionDecision,
  type PermissionRequestPayload,
  type SessionPhase,
  type SessionSnapshotPayload,
  type StatusPayload,
} from '@mobile-claude/protocol'
import { AuthService } from './auth.js'
import type { AgentConfig } from './config.js'
import { openDb, type AppDatabase } from './db.js'
import { listWorkspaceDir, readWorkspaceFile } from './fsApi.js'
import {
  runAgentLoop,
  type PermissionRequest,
  type SessionPhase as LoopPhase,
} from './anthropic/loop.js'
import type { UserDecision } from './permissions.js'
import { SessionStore } from './sessionStore.js'

const SERVER_VERSION = '0.1.0'
const MAX_FRAME_BYTES = 2 * 1024 * 1024
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000
const CHAT_IDEM_TTL_MS = 5 * 60 * 1000

export type StartServerResult = {
  close(): Promise<void>
  pairingCode: string
  /** Actual bound port (useful when config.port is 0). */
  port: number
  host: string
}

export type StartServerOptions = {
  /** Override API key lookup (tests). Never from WS. */
  apiKey?: string | null
  /**
   * Inject agent loop (tests). When omitted, uses runAgentLoop + env key.
   */
  runLoop?: typeof runAgentLoop
}

type PendingPermission = {
  request: PermissionRequest
  sessionId: string
  resolve: (d: UserDecision) => void
  timer: ReturnType<typeof setTimeout>
}

type SessionRuntime = {
  phase: SessionPhase
  model: string
  busy: boolean
  abort?: AbortController
  loopPromise?: Promise<void>
}

type ClientConn = {
  ws: WebSocket
  authenticated: boolean
  deviceId: string | null
}

function send(ws: WebSocket, env: Envelope): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(env))
  }
}

function sendError(
  ws: WebSocket,
  code: ErrorCode,
  message: string,
  opts?: { replyTo?: string; sessionId?: string; details?: unknown },
): void {
  const payload: ErrorPayload = {
    code,
    message,
    ...(opts?.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
    ...(opts?.details !== undefined ? { details: opts.details } : {}),
  }
  send(
    ws,
    createEnvelope('error', payload, {
      sessionId: opts?.sessionId,
    }),
  )
}

function mapRole(role: string): 'user' | 'assistant' | 'system' | 'tool' {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') {
    return role
  }
  return 'system'
}

/**
 * Start the agent WebSocket server.
 * Creates a pairing code on boot (printed by CLI). Default bind 127.0.0.1.
 */
export async function startServer(
  config: AgentConfig,
  opts: StartServerOptions = {},
): Promise<StartServerResult> {
  // Mutable runtime config (config.set); never exposes API key
  const runtime: {
    defaultModel: string
    autoAllowReadTools: boolean
    workspaceRoot: string
    shell: AgentConfig['shell']
    dataDir: string
    host: string
    port: number
    pairingCodeTtlMs: number
  } = {
    defaultModel: config.defaultModel,
    autoAllowReadTools: config.autoAllowReadTools,
    workspaceRoot: config.workspaceRoot,
    shell: config.shell,
    dataDir: config.dataDir,
    host: config.host,
    port: config.port,
    pairingCodeTtlMs: config.pairingCodeTtlMs,
  }

  const db: AppDatabase = await openDb(runtime.dataDir)
  const auth = new AuthService(db, { pairingCodeTtlMs: runtime.pairingCodeTtlMs })
  const store = new SessionStore(db, runtime.defaultModel)

  const pairing = auth.createPairingCode()

  const pendingPermissions = new Map<string, PendingPermission>()
  const sessionRuntime = new Map<string, SessionRuntime>()
  /** Recent chat.send envelope ids → acceptedAt (idempotency). */
  const chatIdem = new Map<string, number>()
  /** Authenticated sockets — used for reconnect fan-out of live events. */
  const authenticatedConns = new Set<ClientConn>()
  /** Spec default: at most 2 concurrent agent generations globally. */
  const MAX_GLOBAL_GENERATIONS = 2
  let activeGenerations = 0

  const loopFn = opts.runLoop ?? runAgentLoop

  function getAgentConfig(): AgentConfig {
    return {
      host: runtime.host,
      port: runtime.port,
      workspaceRoot: runtime.workspaceRoot,
      dataDir: runtime.dataDir,
      defaultModel: runtime.defaultModel,
      shell: runtime.shell,
      autoAllowReadTools: runtime.autoAllowReadTools,
      pairingCodeTtlMs: runtime.pairingCodeTtlMs,
    }
  }

  function ensureRuntime(sessionId: string): SessionRuntime {
    let r = sessionRuntime.get(sessionId)
    if (!r) {
      const session = store.get(sessionId)
      r = {
        phase: 'idle',
        model: session?.model ?? runtime.defaultModel,
        busy: false,
      }
      sessionRuntime.set(sessionId, r)
    }
    return r
  }

  function statusPayload(sessionId: string): StatusPayload {
    const r = ensureRuntime(sessionId)
    return { phase: r.phase, model: r.model, busy: r.busy }
  }

  function buildSnapshot(sessionId: string): SessionSnapshotPayload | null {
    const session = store.get(sessionId)
    if (!session) return null

    const messages = store.listMessages(sessionId).map((m) => ({
      id: m.id,
      role: mapRole(m.role),
      content: m.content,
      createdAt: m.created_at,
    }))

    let pendingPermission: PermissionRequestPayload | null = null
    for (const p of pendingPermissions.values()) {
      if (p.sessionId === sessionId) {
        pendingPermission = {
          requestId: p.request.requestId,
          toolRunId: p.request.toolRunId,
          name: p.request.name,
          input: p.request.input,
          risk: p.request.risk,
        }
        break
      }
    }

    return {
      sessionId: session.id,
      title: session.title,
      messages,
      pendingPermission,
      status: statusPayload(sessionId),
    }
  }

  function permissionPayload(p: PendingPermission): PermissionRequestPayload {
    return {
      requestId: p.request.requestId,
      toolRunId: p.request.toolRunId,
      name: p.request.name,
      input: p.request.input,
      risk: p.request.risk,
    }
  }

  /** Re-deliver pending permission.request for one session (session.open). */
  function resendPendingPermission(ws: WebSocket, sessionId: string): void {
    for (const p of pendingPermissions.values()) {
      if (p.sessionId === sessionId) {
        send(
          ws,
          createEnvelope('permission.request', permissionPayload(p), {
            sessionId,
          }),
        )
      }
    }
  }

  /** Re-deliver every pending permission.request (re-auth.hello after WS drop). */
  function resendAllPendingPermissions(ws: WebSocket): void {
    for (const p of pendingPermissions.values()) {
      send(
        ws,
        createEnvelope('permission.request', permissionPayload(p), {
          sessionId: p.sessionId,
        }),
      )
    }
  }

  /**
   * Push an envelope to a preferred socket if still open; otherwise any
   * authenticated client. Survives mobile background WS drops mid-turn.
   */
  function pushLive(env: Envelope, preferred?: WebSocket): void {
    if (preferred && preferred.readyState === WebSocket.OPEN) {
      send(preferred, env)
      return
    }
    for (const c of authenticatedConns) {
      if (c.authenticated && c.ws.readyState === WebSocket.OPEN) {
        send(c.ws, env)
        return
      }
    }
  }

  function pruneChatIdem(now: number): void {
    for (const [id, at] of chatIdem) {
      if (now - at > CHAT_IDEM_TTL_MS) chatIdem.delete(id)
    }
  }

  function resolveApiKey(): string | undefined {
    if (opts.apiKey === null) return undefined
    if (typeof opts.apiKey === 'string' && opts.apiKey.length > 0) {
      return opts.apiKey
    }
    const fromEnv = process.env.ANTHROPIC_API_KEY
    return fromEnv && fromEnv.length > 0 ? fromEnv : undefined
  }

  const wss = new WebSocketServer({
    host: runtime.host,
    port: runtime.port,
    maxPayload: MAX_FRAME_BYTES,
  })

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve())
    wss.once('error', (err) => reject(err))
  })

  const addr = wss.address() as AddressInfo | null
  const boundPort = addr?.port ?? runtime.port
  runtime.port = boundPort

  wss.on('connection', (ws) => {
    const conn: ClientConn = {
      ws,
      authenticated: false,
      deviceId: null,
    }

    ws.on('message', (data, isBinary) => {
      void handleRawMessage(conn, data, isBinary)
    })

    ws.on('error', (err) => {
      console.error('[server] ws error:', err instanceof Error ? err.message : err)
    })

    ws.on('close', () => {
      authenticatedConns.delete(conn)
      conn.authenticated = false
      conn.deviceId = null
    })
  })

  async function handleRawMessage(
    conn: ClientConn,
    data: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      sendError(conn.ws, 'validation', 'binary frames are not supported')
      return
    }

    const raw =
      typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data as ArrayBuffer).toString('utf8')

    let env: Envelope
    try {
      env = parseEnvelope(raw)
    } catch (err) {
      const msg =
        err instanceof ProtocolError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'invalid envelope'
      sendError(conn.ws, 'validation', msg)
      return
    }

    try {
      await routeMessage(conn, env)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[server] handler error type=${env.type}:`, msg)
      sendError(conn.ws, 'internal', 'internal server error', {
        replyTo: env.id,
        sessionId: env.sessionId,
      })
    }
  }

  async function routeMessage(conn: ClientConn, env: Envelope): Promise<void> {
    const { type } = env
    const replyTo = env.id

    // ── Auth gate ──────────────────────────────────────────────────────────
    if (type !== 'auth.pair' && type !== 'auth.hello') {
      if (!conn.authenticated) {
        sendError(conn.ws, 'unauthorized', 'authenticate first (auth.pair or auth.hello)', {
          replyTo,
        })
        return
      }
    }

    switch (type) {
      case 'auth.pair':
        return handleAuthPair(conn, env)
      case 'auth.hello':
        return handleAuthHello(conn, env)
      case 'session.list':
        return handleSessionList(conn, env)
      case 'session.create':
        return handleSessionCreate(conn, env)
      case 'session.open':
        return handleSessionOpen(conn, env)
      case 'session.delete':
        return handleSessionDelete(conn, env)
      case 'chat.send':
        return handleChatSend(conn, env)
      case 'chat.abort':
        return handleChatAbort(conn, env)
      case 'permission.respond':
        return handlePermissionRespond(conn, env)
      case 'slash.run':
        return handleSlashRun(conn, env)
      case 'fs.list':
        return handleFsList(conn, env)
      case 'fs.read':
        return handleFsRead(conn, env)
      case 'config.get':
        return handleConfigGet(conn, env)
      case 'config.set':
        return handleConfigSet(conn, env)
      default:
        sendError(conn.ws, 'validation', `unknown message type: ${type}`, {
          replyTo,
        })
    }
  }

  function handleAuthPair(conn: ClientConn, env: Envelope): void {
    const parsed = AuthPairPayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    try {
      const result = auth.pair(parsed.data.code, parsed.data.deviceName)
      conn.authenticated = true
      conn.deviceId = result.deviceId
      authenticatedConns.add(conn)

      send(
        conn.ws,
        createEnvelope('auth.pair_result', {
          deviceToken: result.deviceToken,
          deviceId: result.deviceId,
        }),
      )
      send(
        conn.ws,
        createEnvelope('auth.ok', {
          deviceId: result.deviceId,
          workspaceRoot: runtime.workspaceRoot,
          serverVersion: SERVER_VERSION,
        }),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      sendError(conn.ws, 'unauthorized', msg, { replyTo: env.id })
    }
  }

  function handleAuthHello(conn: ClientConn, env: Envelope): void {
    const parsed = AuthHelloPayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      conn.ws.close(4001, 'invalid auth.hello')
      return
    }

    const deviceId = auth.verifyToken(parsed.data.deviceToken)
    if (!deviceId) {
      sendError(conn.ws, 'unauthorized', 'invalid device token', {
        replyTo: env.id,
      })
      conn.ws.close(4001, 'unauthorized')
      return
    }

    conn.authenticated = true
    conn.deviceId = deviceId
    authenticatedConns.add(conn)

    send(
      conn.ws,
      createEnvelope('auth.ok', {
        deviceId,
        workspaceRoot: runtime.workspaceRoot,
        serverVersion: SERVER_VERSION,
      }),
    )

    // Spec §5.4: pending permission.request survives reconnect — re-deliver on re-hello.
    resendAllPendingPermissions(conn.ws)
  }

  function handleSessionList(conn: ClientConn, env: Envelope): void {
    const parsed = SessionListPayloadSchema.safeParse(env.payload ?? {})
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    const sessions = store.list().map((s) => ({
      id: s.id,
      title: s.title,
      model: s.model,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    }))

    send(conn.ws, createEnvelope('session.list_result', { sessions }))
  }

  function handleSessionCreate(conn: ClientConn, env: Envelope): void {
    const parsed = SessionCreatePayloadSchema.safeParse(env.payload ?? {})
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    let row = store.create(parsed.data.title)
    // SessionStore captures constructor defaultModel; keep in sync with runtime config.set
    if (row.model !== runtime.defaultModel) {
      store.setModel(row.id, runtime.defaultModel)
      row = store.get(row.id) ?? row
    }
    ensureRuntime(row.id).model = row.model
    const snap = buildSnapshot(row.id)
    if (snap) {
      send(conn.ws, createEnvelope('session.snapshot', snap, { sessionId: row.id }))
    }
  }

  function handleSessionOpen(conn: ClientConn, env: Envelope): void {
    const parsed = SessionOpenPayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    const { sessionId } = parsed.data
    const snap = buildSnapshot(sessionId)
    if (!snap) {
      sendError(conn.ws, 'not_found', `session not found: ${sessionId}`, {
        replyTo: env.id,
        sessionId,
      })
      return
    }

    send(conn.ws, createEnvelope('session.snapshot', snap, { sessionId }))
    resendPendingPermission(conn.ws, sessionId)
  }

  function handleSessionDelete(conn: ClientConn, env: Envelope): void {
    const parsed = SessionDeletePayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    const { sessionId } = parsed.data
    const rt = sessionRuntime.get(sessionId)
    if (rt?.busy) {
      sendError(conn.ws, 'busy', 'session is busy; abort first', {
        replyTo: env.id,
        sessionId,
      })
      return
    }

    // Drop pending permissions for this session
    for (const [rid, p] of pendingPermissions) {
      if (p.sessionId === sessionId) {
        clearTimeout(p.timer)
        p.resolve('deny')
        pendingPermissions.delete(rid)
      }
    }

    const ok = store.delete(sessionId)
    if (!ok) {
      sendError(conn.ws, 'not_found', `session not found: ${sessionId}`, {
        replyTo: env.id,
        sessionId,
      })
      return
    }

    sessionRuntime.delete(sessionId)

    const sessions = store.list().map((s) => ({
      id: s.id,
      title: s.title,
      model: s.model,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
    }))
    send(conn.ws, createEnvelope('session.list_result', { sessions }))
  }

  function handleChatSend(conn: ClientConn, env: Envelope): void {
    const parsed = ChatSendPayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    const now = Date.now()
    pruneChatIdem(now)
    // Spec §4.4: duplicate client envelope id within 5 min is ignored if already accepted
    if (chatIdem.has(env.id)) {
      return
    }

    const { sessionId, text } = parsed.data
    const session = store.get(sessionId)
    if (!session) {
      sendError(conn.ws, 'not_found', `session not found: ${sessionId}`, {
        replyTo: env.id,
        sessionId,
      })
      return
    }

    const rt = ensureRuntime(sessionId)
    if (rt.busy) {
      sendError(conn.ws, 'busy', 'session already has an active turn', {
        replyTo: env.id,
        sessionId,
      })
      return
    }

    if (activeGenerations >= MAX_GLOBAL_GENERATIONS) {
      sendError(
        conn.ws,
        'busy',
        `too many concurrent generations (max ${MAX_GLOBAL_GENERATIONS})`,
        { replyTo: env.id, sessionId },
      )
      return
    }

    const apiKey = resolveApiKey()
    // Allow runLoop injection without key (tests); real path needs key unless injected
    if (!opts.runLoop && !apiKey) {
      sendError(
        conn.ws,
        'upstream',
        'ANTHROPIC_API_KEY is not configured on the host (never send keys over WebSocket)',
        { replyTo: env.id, sessionId },
      )
      return
    }

    // Mark accepted only after validation — failures must remain retriable
    chatIdem.set(env.id, now)

    const abort = new AbortController()
    rt.abort = abort
    rt.busy = true
    activeGenerations += 1
    rt.phase = 'thinking'
    rt.model = session.model || runtime.defaultModel

    // Capture preferred socket at start; pushLive falls back after reconnect.
    const originWs = conn.ws

    pushLive(
      createEnvelope(
        'status',
        {
          phase: rt.phase,
          model: rt.model,
          busy: true,
        } satisfies StatusPayload,
        { sessionId },
      ),
      originWs,
    )

    const events = {
      onDelta: (delta: string, messageId: string) => {
        pushLive(
          createEnvelope(
            'message.delta',
            { messageId, role: 'assistant' as const, text: delta },
            { sessionId },
          ),
          originWs,
        )
      },
      onToolStarted: (args: {
        toolRunId: string
        name: string
        inputSummary: string
        input: unknown
      }) => {
        pushLive(
          createEnvelope(
            'tool.started',
            {
              toolRunId: args.toolRunId,
              name: args.name,
              inputSummary: args.inputSummary,
              input: args.input,
            },
            { sessionId },
          ),
          originWs,
        )
      },
      onPermissionRequired: (req: PermissionRequest): Promise<UserDecision> => {
        return new Promise<UserDecision>((resolve) => {
          const timer = setTimeout(() => {
            const pending = pendingPermissions.get(req.requestId)
            if (pending) {
              pendingPermissions.delete(req.requestId)
              pending.resolve('deny')
            }
          }, PERMISSION_TIMEOUT_MS)

          pendingPermissions.set(req.requestId, {
            request: req,
            sessionId,
            resolve: (d) => {
              clearTimeout(timer)
              pendingPermissions.delete(req.requestId)
              resolve(d)
            },
            timer,
          })

          pushLive(
            createEnvelope(
              'permission.request',
              {
                requestId: req.requestId,
                toolRunId: req.toolRunId,
                name: req.name,
                input: req.input,
                risk: req.risk,
              } satisfies PermissionRequestPayload,
              { sessionId },
            ),
            originWs,
          )
        })
      },
      onToolCompleted: (args: {
        toolRunId: string
        status: string
        outputSummary: string
        output?: unknown
        truncated?: boolean
      }) => {
        pushLive(
          createEnvelope(
            'tool.completed',
            {
              toolRunId: args.toolRunId,
              status: args.status,
              outputSummary: args.outputSummary,
              ...(args.output !== undefined ? { output: args.output } : {}),
              ...(args.truncated ? { truncated: true } : {}),
            },
            { sessionId },
          ),
          originWs,
        )
      },
      onDiff: (args: {
        toolRunId: string
        path: string
        before?: string
        after?: string
        unifiedDiff: string
      }) => {
        pushLive(
          createEnvelope(
            'diff.available',
            {
              toolRunId: args.toolRunId,
              path: args.path,
              before: args.before,
              after: args.after,
              unifiedDiff: args.unifiedDiff,
            },
            { sessionId },
          ),
          originWs,
        )
      },
      onStatus: (phase: LoopPhase, meta?: { model: string; busy: boolean }) => {
        rt.phase = phase
        if (meta?.model) rt.model = meta.model
        if (meta?.busy !== undefined) rt.busy = meta.busy
        pushLive(
          createEnvelope(
            'status',
            {
              phase: rt.phase,
              model: rt.model,
              busy: rt.busy,
            } satisfies StatusPayload,
            { sessionId },
          ),
          originWs,
        )
      },
      onMessageCompleted: (args: { messageId: string; stopReason: string }) => {
        pushLive(
          createEnvelope(
            'message.completed',
            {
              messageId: args.messageId,
              stopReason: args.stopReason,
            },
            { sessionId },
          ),
          originWs,
        )
      },
    }

    const agentConfig = getAgentConfig()

    rt.loopPromise = loopFn({
      sessionId,
      store,
      config: agentConfig,
      userText: text,
      signal: abort.signal,
      events,
      ...(apiKey ? { apiKey } : {}),
    })
      .catch((err: unknown) => {
        if (abort.signal.aborted) {
          const abortEnv = createEnvelope(
            'error',
            {
              code: 'aborted' as ErrorCode,
              message: 'turn aborted',
              replyTo: env.id,
            } satisfies ErrorPayload,
            { sessionId },
          )
          pushLive(abortEnv, originWs)
          return
        }
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[server] agent loop error:', msg)
        pushLive(
          createEnvelope(
            'error',
            {
              code: 'upstream' as ErrorCode,
              message: msg,
              replyTo: env.id,
            } satisfies ErrorPayload,
            { sessionId },
          ),
          originWs,
        )
      })
      .finally(() => {
        rt.busy = false
        rt.phase = 'idle'
        rt.abort = undefined
        rt.loopPromise = undefined
        if (activeGenerations > 0) activeGenerations -= 1
        pushLive(
          createEnvelope(
            'status',
            {
              phase: 'idle',
              model: rt.model,
              busy: false,
            } satisfies StatusPayload,
            { sessionId },
          ),
          originWs,
        )
      })
  }

  function handleChatAbort(conn: ClientConn, env: Envelope): void {
    const parsed = ChatAbortPayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    const { sessionId } = parsed.data
    const rt = sessionRuntime.get(sessionId)

    // Abort first so raceAbort on permission waits rejects with aborted
    // (before deny resolve can win Promise.race).
    if (rt?.abort) {
      rt.abort.abort(new Error('aborted'))
    }

    // Unblock any permission waiters for this session (deny + clear)
    for (const [rid, p] of pendingPermissions) {
      if (p.sessionId === sessionId) {
        clearTimeout(p.timer)
        p.resolve('deny')
        pendingPermissions.delete(rid)
      }
    }

    if (!rt?.abort) {
      // Nothing was running — still ok (pending perms already cleared above)
      send(
        conn.ws,
        createEnvelope(
          'status',
          statusPayload(sessionId),
          { sessionId },
        ),
      )
    }
  }

  function handlePermissionRespond(conn: ClientConn, env: Envelope): void {
    const parsed = PermissionRespondPayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    const { requestId, decision } = parsed.data
    const pending = pendingPermissions.get(requestId)
    if (!pending) {
      sendError(conn.ws, 'not_found', `unknown or expired permission request: ${requestId}`, {
        replyTo: env.id,
      })
      return
    }

    const decisionMap: Record<PermissionDecision, UserDecision> = {
      allow_once: 'allow_once',
      allow_session: 'allow_session',
      deny: 'deny',
    }
    pending.resolve(decisionMap[decision])
  }

  function handleSlashRun(conn: ClientConn, env: Envelope): void {
    const parsed = SlashRunPayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    const { sessionId, command, args } = parsed.data
    const session = store.get(sessionId)
    if (!session) {
      sendError(conn.ws, 'not_found', `session not found: ${sessionId}`, {
        replyTo: env.id,
        sessionId,
      })
      return
    }

    const rt = ensureRuntime(sessionId)
    if (rt.busy) {
      sendError(conn.ws, 'busy', 'session is busy', {
        replyTo: env.id,
        sessionId,
      })
      return
    }

    if (command === 'clear') {
      store.clearMessages(sessionId)
      // clear pending permissions for session
      for (const [rid, p] of pendingPermissions) {
        if (p.sessionId === sessionId) {
          clearTimeout(p.timer)
          p.resolve('deny')
          pendingPermissions.delete(rid)
        }
      }
      const snap = buildSnapshot(sessionId)
      if (snap) {
        send(conn.ws, createEnvelope('session.snapshot', snap, { sessionId }))
      }
      return
    }

    if (command === 'model') {
      const model = (args ?? '').trim()
      if (!model) {
        // No args: report current model (session override or default)
        const current = session.model || runtime.defaultModel
        rt.model = current
        send(
          conn.ws,
          createEnvelope(
            'status',
            {
              phase: rt.phase,
              model: current,
              busy: rt.busy,
            } satisfies StatusPayload,
            { sessionId, id: env.id },
          ),
        )
        return
      }
      store.setModel(sessionId, model)
      rt.model = model
      send(
        conn.ws,
        createEnvelope(
          'status',
          { phase: rt.phase, model, busy: rt.busy } satisfies StatusPayload,
          { sessionId },
        ),
      )
      const snap = buildSnapshot(sessionId)
      if (snap) {
        send(conn.ws, createEnvelope('session.snapshot', snap, { sessionId }))
      }
      return
    }

    sendError(conn.ws, 'validation', `unsupported slash command: ${command}`, {
      replyTo: env.id,
      sessionId,
    })
  }

  function handleFsList(conn: ClientConn, env: Envelope): void {
    const parsed = FsListPayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    try {
      const result = listWorkspaceDir(runtime.workspaceRoot, parsed.data.path)
      send(
        conn.ws,
        createEnvelope('fs.list_result', result, { id: env.id }),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code: ErrorCode =
        err instanceof Error && err.name === 'PathEscapeError'
          ? 'forbidden'
          : 'tool_failed'
      sendError(conn.ws, code, msg, { replyTo: env.id })
    }
  }

  function handleFsRead(conn: ClientConn, env: Envelope): void {
    const parsed = FsReadPayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    try {
      const result = readWorkspaceFile(
        runtime.workspaceRoot,
        parsed.data.path,
        parsed.data.maxBytes,
      )
      send(
        conn.ws,
        createEnvelope('fs.read_result', result, { id: env.id }),
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code: ErrorCode =
        err instanceof Error && err.name === 'PathEscapeError'
          ? 'forbidden'
          : 'tool_failed'
      sendError(conn.ws, code, msg, { replyTo: env.id })
    }
  }

  function handleConfigGet(conn: ClientConn, env: Envelope): void {
    const parsed = ConfigGetPayloadSchema.safeParse(env.payload ?? {})
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    // Never include API key
    send(
      conn.ws,
      createEnvelope('config', {
        model: runtime.defaultModel,
        autoAllowReadTools: runtime.autoAllowReadTools,
        workspaceRoot: runtime.workspaceRoot,
        host: runtime.host,
        port: runtime.port,
        serverVersion: SERVER_VERSION,
        hasApiKey: Boolean(resolveApiKey()),
      }),
    )
  }

  function handleConfigSet(conn: ClientConn, env: Envelope): void {
    // Reject API key smuggling before schema parse (strict() would only yield validation)
    const raw = env.payload
    if (
      raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      ('apiKey' in raw ||
        'anthropicApiKey' in raw ||
        'ANTHROPIC_API_KEY' in raw ||
        'api_key' in raw)
    ) {
      sendError(
        conn.ws,
        'forbidden',
        'API keys cannot be set over WebSocket; use host env ANTHROPIC_API_KEY',
        { replyTo: env.id },
      )
      return
    }

    const parsed = ConfigSetPayloadSchema.safeParse(env.payload)
    if (!parsed.success) {
      sendError(conn.ws, 'validation', parsed.error.message, { replyTo: env.id })
      return
    }

    if (parsed.data.model !== undefined) {
      runtime.defaultModel = parsed.data.model
    }
    if (parsed.data.autoAllowReadTools !== undefined) {
      runtime.autoAllowReadTools = parsed.data.autoAllowReadTools
    }

    send(
      conn.ws,
      createEnvelope('config', {
        model: runtime.defaultModel,
        autoAllowReadTools: runtime.autoAllowReadTools,
        workspaceRoot: runtime.workspaceRoot,
        host: runtime.host,
        port: runtime.port,
        serverVersion: SERVER_VERSION,
        hasApiKey: Boolean(resolveApiKey()),
      }),
    )
  }

  let closed = false

  async function close(): Promise<void> {
    if (closed) return
    closed = true

    for (const p of pendingPermissions.values()) {
      clearTimeout(p.timer)
      p.resolve('deny')
    }
    pendingPermissions.clear()

    for (const rt of sessionRuntime.values()) {
      rt.abort?.abort(new Error('server shutting down'))
    }

    await new Promise<void>((resolve) => {
      wss.close(() => resolve())
    })

    for (const client of wss.clients) {
      client.terminate()
    }

    db.close()
  }

  return {
    close,
    pairingCode: pairing.code,
    port: boundPort,
    host: runtime.host,
  }
}
