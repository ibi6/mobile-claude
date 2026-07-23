# Task 9 Report — Mobile WS client + Pair + Sessions screens

**Status:** DONE  
**Date:** 2026-07-23  
**Commit:** `feat(mobile): pair flow and session list`

---

## Summary

Implemented React Native WebSocket `AgentClient` (connect / send / on / disconnect, backoff reconnect + re-`auth.hello`), `ConnectionProvider` + `SessionsProvider` state, full Chinese Pair form (`auth.pair` → SecureStore → Main), and Sessions list (`session.list`, FAB create, tap → Chat, long-press delete).

---

## What was created / modified

| File | Purpose |
|---|---|
| `apps/mobile/src/protocol/client.ts` | `AgentClient` over global `WebSocket` |
| `apps/mobile/src/state/connection.ts` | `ConnectionProvider` / `useConnection` |
| `apps/mobile/src/state/sessions.ts` | `SessionsProvider` / `useSessions` |
| `apps/mobile/src/screens/PairScreen.tsx` | host / port / code / deviceName form |
| `apps/mobile/src/screens/SessionsScreen.tsx` | list + FAB + delete + status badge |
| `apps/mobile/App.tsx` | wrap providers; hydrate via connection context |
| `apps/mobile/src/navigation.tsx` | comment only |
| `apps/mobile/src/protocol/version.ts` | comment only |

### Interfaces

```ts
// AgentClient
class AgentClient {
  connect(): Promise<void>
  disconnect(): void
  send(type: string, payload: unknown, sessionId?: string): string
  on(type: string, cb: (env: Envelope) => void): () => void
  request(type, payload, expectTypes, opts?): Promise<Envelope>
}

// ConnectionProvider
pair({ host, port, code, deviceName }): Promise<void>
reconnect(): Promise<void>
disconnectAndForget(): Promise<void>
// + status, client, connectionInfo, auth, hasConnection

// SessionsProvider
refresh() / createSession(title?) / deleteSession(sessionId)
// + sessions: SessionSummary[]
```

### Behavior notes

- Pair uses one-shot client (`autoReconnect: false`), then persists token and opens main client with reconnect.
- Main client auto-reconnects with jittered exponential backoff and re-sends `auth.hello` when `deviceToken` is set.
- Default pair port `7820` (agent config default).
- Session delete: long-press → confirm → `session.delete` → apply `session.list_result`.

---

## Verification

```text
pnpm --filter mobile-claude typecheck
> tsc --noEmit
exit 0
```

Manual E2E against local daemon (Task 7) not run in this agent environment (no interactive device / pairing session).

---

## Notes / out of scope

- Chat streaming / tool cards → Task 10
- Permission sheet / diff → Task 11
- Settings disconnect UI can call `disconnectAndForget` later
