/**
 * WebSocket client for the agent daemon protocol.
 * Uses React Native global WebSocket; auto-reconnects and re-sends auth.hello.
 */

import {
  createEnvelope,
  parseEnvelope,
  type AuthOkPayload,
  type Envelope,
  type ErrorPayload,
} from '@mobile-claude/protocol';

const DEFAULT_CLIENT_VERSION = '0.1.0';
const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 20_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export type AgentClientOptions = {
  host: string;
  port: number;
  deviceToken?: string;
  clientVersion?: string;
  /** Default true when deviceToken is set; false for one-shot pair. */
  autoReconnect?: boolean;
};

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'authenticating'
  | 'authenticated'
  | 'closed'
  | 'error';

type EnvelopeHandler = (env: Envelope) => void;

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Fallback for older RN runtimes without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function backoffMs(attempt: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt));
  // Full jitter
  return Math.floor(Math.random() * exp) + BASE_BACKOFF_MS / 2;
}

/**
 * Agent protocol client over `ws://host:port`.
 * After open, if `deviceToken` is set, automatically sends `auth.hello`.
 */
export class AgentClient {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<EnvelopeHandler>>();
  private readonly anyHandlers = new Set<EnvelopeHandler>();
  private status: ConnectionStatus = 'idle';
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectWaiters: {
    resolve: () => void;
    reject: (err: Error) => void;
  }[] = [];
  private lastAuth: AuthOkPayload | null = null;
  private lastError: string | null = null;
  private readonly autoReconnect: boolean;
  private deviceToken: string | undefined;
  private readonly clientVersion: string;
  private readonly host: string;
  private readonly port: number;
  private statusListeners = new Set<(s: ConnectionStatus) => void>();

  constructor(opts: AgentClientOptions) {
    this.host = opts.host.trim();
    this.port = opts.port;
    this.deviceToken = opts.deviceToken;
    this.clientVersion = opts.clientVersion ?? DEFAULT_CLIENT_VERSION;
    this.autoReconnect =
      opts.autoReconnect ?? (opts.deviceToken !== undefined && opts.deviceToken.length > 0);
  }

  getConnectionStatus(): ConnectionStatus {
    return this.status;
  }

  getLastAuth(): AuthOkPayload | null {
    return this.lastAuth;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getUrl(): string {
    return `ws://${this.host}:${this.port}`;
  }

  setDeviceToken(token: string | undefined): void {
    this.deviceToken = token;
  }

  onStatus(cb: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  /**
   * Open WebSocket and (when token present) complete auth.hello.
   * Resolves when socket is open and authenticated (or open-only if no token).
   */
  connect(): Promise<void> {
    if (
      this.status === 'authenticated' ||
      (this.status === 'open' && !this.deviceToken)
    ) {
      return Promise.resolve();
    }

    if (
      this.ws &&
      (this.status === 'connecting' ||
        this.status === 'authenticating' ||
        this.status === 'open')
    ) {
      return new Promise((resolve, reject) => {
        this.connectWaiters.push({ resolve, reject });
      });
    }

    this.intentionalClose = false;
    return this.openSocket();
  }

  /** Close socket and cancel reconnect. */
  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.rejectConnectWaiters(new Error('已断开连接'));
    if (this.ws) {
      try {
        this.ws.close(1000, 'client disconnect');
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.setStatus('closed');
    this.lastAuth = null;
  }

  /**
   * Send a protocol envelope. Returns envelope id.
   * Throws if socket is not open.
   */
  send(type: string, payload: unknown, sessionId?: string): string {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接');
    }
    const env = createEnvelope(type, payload, {
      id: newId(),
      sessionId,
    });
    this.ws.send(JSON.stringify(env));
    return env.id;
  }

  /**
   * Subscribe to envelopes of a given type. Returns unsubscribe.
   * Use `'*'` for all messages.
   */
  on(type: string, cb: EnvelopeHandler): () => void {
    if (type === '*') {
      this.anyHandlers.add(cb);
      return () => {
        this.anyHandlers.delete(cb);
      };
    }
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  /**
   * Send a request and wait for one of `expectTypes`, or an `error` with matching replyTo.
   */
  request(
    type: string,
    payload: unknown,
    expectTypes: string[],
    opts?: { sessionId?: string; timeoutMs?: number },
  ): Promise<Envelope> {
    const timeoutMs = opts?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const id = this.send(type, payload, opts?.sessionId);
    const expect = new Set(expectTypes);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`请求超时：${type}`));
      }, timeoutMs);

      const unsub = this.on('*', (env) => {
        if (expect.has(env.type)) {
          clearTimeout(timer);
          unsub();
          resolve(env);
          return;
        }
        if (env.type === 'error') {
          const errPayload = env.payload as ErrorPayload;
          if (errPayload.replyTo === id) {
            clearTimeout(timer);
            unsub();
            reject(new Error(errPayload.message || errPayload.code || '协议错误'));
          }
        }
      });
    });
  }

  private setStatus(next: ConnectionStatus): void {
    this.status = next;
    for (const cb of this.statusListeners) {
      try {
        cb(next);
      } catch {
        // ignore listener errors
      }
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private resolveConnectWaiters(): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) {
      w.resolve();
    }
  }

  private rejectConnectWaiters(err: Error): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) {
      w.reject(err);
    }
  }

  private openSocket(): Promise<void> {
    this.clearReconnectTimer();
    this.setStatus('connecting');
    this.lastError = null;

    const url = this.getUrl();
    let settled = false;

    return new Promise((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastError = message;
        this.setStatus('error');
        this.rejectConnectWaiters(new Error(message));
        this.scheduleReconnect();
        return;
      }

      this.ws = ws;

      const connectTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            // ignore
          }
          this.lastError = '连接超时';
          this.setStatus('error');
          this.rejectConnectWaiters(new Error('连接超时'));
          this.scheduleReconnect();
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        void this.handleOpen(connectTimer, () => {
          settled = true;
        });
      };

      ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      ws.onerror = () => {
        // onclose usually follows; record generic error
        this.lastError = this.lastError ?? 'WebSocket 错误';
      };

      ws.onclose = () => {
        clearTimeout(connectTimer);
        this.ws = null;
        this.lastAuth = null;
        if (this.intentionalClose) {
          this.setStatus('closed');
          return;
        }
        this.setStatus('closed');
        if (!settled) {
          settled = true;
          const err = new Error(this.lastError ?? '连接已关闭');
          this.rejectConnectWaiters(err);
        }
        this.scheduleReconnect();
      };
    });
  }

  private async handleOpen(
    connectTimer: ReturnType<typeof setTimeout>,
    markSettled: () => void,
  ): Promise<void> {
    clearTimeout(connectTimer);
    this.reconnectAttempt = 0;
    this.setStatus('open');

    if (!this.deviceToken) {
      markSettled();
      this.resolveConnectWaiters();
      return;
    }

    this.setStatus('authenticating');
    try {
      const env = await this.request(
        'auth.hello',
        {
          deviceToken: this.deviceToken,
          clientVersion: this.clientVersion,
        },
        ['auth.ok'],
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      const auth = env.payload as AuthOkPayload;
      this.lastAuth = auth;
      this.setStatus('authenticated');
      markSettled();
      this.resolveConnectWaiters();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.setStatus('error');
      markSettled();
      this.rejectConnectWaiters(new Error(message));
      // Invalid token: do not thrash reconnect forever; still backoff once connection drops
      try {
        this.ws?.close(4001, 'auth failed');
      } catch {
        // ignore
      }
    }
  }

  private handleMessage(data: unknown): void {
    const raw =
      typeof data === 'string'
        ? data
        : typeof data === 'object' && data !== null && 'toString' in data
          ? String(data)
          : null;
    if (raw === null) {
      return;
    }

    let env: Envelope;
    try {
      env = parseEnvelope(raw);
    } catch {
      return;
    }

    if (env.type === 'auth.ok') {
      this.lastAuth = env.payload as AuthOkPayload;
      this.setStatus('authenticated');
    }

    const typed = this.handlers.get(env.type);
    if (typed) {
      for (const cb of typed) {
        try {
          cb(env);
        } catch {
          // ignore
        }
      }
    }
    for (const cb of this.anyHandlers) {
      try {
        cb(env);
      } catch {
        // ignore
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || !this.autoReconnect) {
      return;
    }
    if (this.reconnectTimer !== null) {
      return;
    }
    const delay = backoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose || !this.autoReconnect) {
        return;
      }
      void this.openSocket().catch(() => {
        // errors already recorded; next reconnect scheduled from onclose
      });
    }, delay);
  }
}
