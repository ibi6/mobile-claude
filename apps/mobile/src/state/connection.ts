/**
 * Connection context: holds AgentClient singleton, pair / reconnect / disconnect.
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthOkPayload, AuthPairResultPayload } from '@mobile-claude/protocol';
import {
  AgentClient,
  type ConnectionStatus,
} from '../protocol/client';
import {
  clearConnection,
  loadConnection,
  saveConnection,
  type ConnectionInfo,
} from '../storage/secure';

export type PairInput = {
  host: string;
  port: number;
  code: string;
  deviceName: string;
};

export type ConnectionContextValue = {
  /** Boot hydration finished (SecureStore read). */
  ready: boolean;
  status: ConnectionStatus;
  client: AgentClient | null;
  connectionInfo: ConnectionInfo | null;
  auth: AuthOkPayload | null;
  error: string | null;
  /** True when a device token is stored (may still be reconnecting). */
  hasConnection: boolean;
  pair: (input: PairInput) => Promise<void>;
  reconnect: () => Promise<void>;
  disconnectAndForget: () => Promise<void>;
};

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

function normalizeHost(host: string): string {
  return host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function parsePort(port: number | string): number {
  const n = typeof port === 'number' ? port : Number.parseInt(String(port).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error('端口必须是 1–65535 的整数');
  }
  return n;
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [auth, setAuth] = useState<AuthOkPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<AgentClient | null>(null);
  const clientRef = useRef<AgentClient | null>(null);
  const statusUnsubRef = useRef<(() => void) | null>(null);

  const attachClient = useCallback((next: AgentClient | null) => {
    statusUnsubRef.current?.();
    statusUnsubRef.current = null;
    if (clientRef.current && clientRef.current !== next) {
      clientRef.current.disconnect();
    }
    clientRef.current = next;
    setClient(next);
    if (next) {
      setStatus(next.getConnectionStatus());
      setAuth(next.getLastAuth());
      statusUnsubRef.current = next.onStatus((s) => {
        setStatus(s);
        setAuth(next.getLastAuth());
        const err = next.getLastError();
        if (err) {
          setError(err);
        }
      });
      return;
    }
    setStatus('idle');
    setAuth(null);
  }, []);

  // Hydrate SecureStore on mount; auto-connect when token present
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const saved = await loadConnection();
        if (cancelled) return;
        if (!saved) {
          setConnectionInfo(null);
          setReady(true);
          return;
        }
        setConnectionInfo(saved);
        const c = new AgentClient({
          host: saved.host,
          port: saved.port,
          deviceToken: saved.deviceToken,
          autoReconnect: true,
        });
        attachClient(c);
        setReady(true);
        try {
          await c.connect();
          if (!cancelled) {
            setAuth(c.getLastAuth());
            setError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setReady(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      statusUnsubRef.current?.();
      statusUnsubRef.current = null;
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, [attachClient]);

  const pair = useCallback(
    async (input: PairInput) => {
      const host = normalizeHost(input.host);
      if (!host) {
        throw new Error('请输入主机地址');
      }
      const port = parsePort(input.port);
      const code = input.code.trim();
      const deviceName = input.deviceName.trim();
      if (!code) {
        throw new Error('请输入配对码');
      }
      if (!deviceName) {
        throw new Error('请输入设备名称');
      }

      setError(null);

      // One-shot client without auto-reconnect for pairing
      const temp = new AgentClient({
        host,
        port,
        autoReconnect: false,
      });

      try {
        await temp.connect();
        const env = await temp.request(
          'auth.pair',
          { code, deviceName },
          ['auth.pair_result'],
        );
        const result = env.payload as AuthPairResultPayload;
        if (!result?.deviceToken) {
          throw new Error('配对响应缺少 deviceToken');
        }

        const info: ConnectionInfo = {
          host,
          port,
          deviceToken: result.deviceToken,
        };
        await saveConnection(info);
        setConnectionInfo(info);

        temp.disconnect();

        const main = new AgentClient({
          host,
          port,
          deviceToken: result.deviceToken,
          autoReconnect: true,
        });
        attachClient(main);
        await main.connect();
        setAuth(main.getLastAuth());
        setError(null);
      } catch (err) {
        temp.disconnect();
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [attachClient],
  );

  const reconnect = useCallback(async () => {
    setError(null);
    const info = connectionInfo ?? (await loadConnection());
    if (!info) {
      throw new Error('尚未配对，请先完成配对');
    }
    setConnectionInfo(info);

    let c = clientRef.current;
    if (
      !c ||
      c.getUrl() !== `ws://${info.host}:${info.port}`
    ) {
      c = new AgentClient({
        host: info.host,
        port: info.port,
        deviceToken: info.deviceToken,
        autoReconnect: true,
      });
      attachClient(c);
    } else {
      c.setDeviceToken(info.deviceToken);
    }

    try {
      await c.connect();
      setAuth(c.getLastAuth());
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    }
  }, [attachClient, connectionInfo]);

  const disconnectAndForget = useCallback(async () => {
    statusUnsubRef.current?.();
    statusUnsubRef.current = null;
    clientRef.current?.disconnect();
    clientRef.current = null;
    setClient(null);
    await clearConnection();
    setConnectionInfo(null);
    setAuth(null);
    setStatus('closed');
    setError(null);
  }, []);

  const value = useMemo<ConnectionContextValue>(
    () => ({
      ready,
      status,
      client,
      connectionInfo,
      auth,
      error,
      hasConnection: connectionInfo !== null,
      pair,
      reconnect,
      disconnectAndForget,
    }),
    [
      ready,
      status,
      client,
      connectionInfo,
      auth,
      error,
      pair,
      reconnect,
      disconnectAndForget,
    ],
  );

  return createElement(ConnectionContext.Provider, { value }, children);
}

export function useConnection(): ConnectionContextValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    throw new Error('useConnection 必须在 ConnectionProvider 内使用');
  }
  return ctx;
}
