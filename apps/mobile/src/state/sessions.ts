/**
 * Session list state: list / create / delete over authenticated AgentClient.
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  SessionListResultPayload,
  SessionSnapshotPayload,
  SessionSummary,
} from '@mobile-claude/protocol';
import { useConnection } from './connection';

export type SessionsContextValue = {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createSession: (title?: string) => Promise<SessionSummary | null>;
  deleteSession: (sessionId: string) => Promise<void>;
};

const SessionsContext = createContext<SessionsContextValue | null>(null);

function summaryFromSnapshot(snap: SessionSnapshotPayload): SessionSummary {
  return {
    id: snap.sessionId,
    title: snap.title,
    model: snap.status?.model,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function SessionsProvider({ children }: { children: ReactNode }) {
  const { client, status } = useConnection();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) {
      setSessions([]);
      return;
    }
    if (status !== 'authenticated' && status !== 'open') {
      // Still allow attempt if socket is up; server requires auth
    }
    setLoading(true);
    setError(null);
    try {
      const env = await client.request('session.list', {}, ['session.list_result']);
      const payload = env.payload as SessionListResultPayload;
      setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setLoading(false);
    }
  }, [client, status]);

  const createSession = useCallback(
    async (title?: string): Promise<SessionSummary | null> => {
      if (!client) {
        throw new Error('未连接');
      }
      setError(null);
      try {
        const env = await client.request(
          'session.create',
          title ? { title } : {},
          ['session.snapshot'],
        );
        const snap = env.payload as SessionSnapshotPayload;
        const summary = summaryFromSnapshot(snap);
        setSessions((prev) => {
          const rest = prev.filter((s) => s.id !== summary.id);
          return [summary, ...rest];
        });
        // Refresh to get authoritative timestamps / order
        void refresh().catch(() => {
          // keep optimistic entry
        });
        return summary;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [client, refresh],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!client) {
        throw new Error('未连接');
      }
      setError(null);
      try {
        const env = await client.request(
          'session.delete',
          { sessionId },
          ['session.list_result'],
        );
        const payload = env.payload as SessionListResultPayload;
        setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [client],
  );

  // Auto-load when authenticated
  useEffect(() => {
    if (status === 'authenticated' && client) {
      void refresh().catch(() => {
        // error already stored
      });
    }
    if (status === 'idle' || status === 'closed') {
      setSessions([]);
    }
  }, [status, client, refresh]);

  const value = useMemo<SessionsContextValue>(
    () => ({
      sessions,
      loading,
      error,
      refresh,
      createSession,
      deleteSession,
    }),
    [sessions, loading, error, refresh, createSession, deleteSession],
  );

  return createElement(SessionsContext.Provider, { value }, children);
}

export function useSessions(): SessionsContextValue {
  const ctx = useContext(SessionsContext);
  if (!ctx) {
    throw new Error('useSessions 必须在 SessionsProvider 内使用');
  }
  return ctx;
}
