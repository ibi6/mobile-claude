# Task 13 Report — Reconnect pending permissions + polish + README

**Status:** DONE  
**Date:** 2026-07-23  
**Commit:** `7c81b6c` — `docs: quickstart and reconnect permission polish`

---

## Summary

Pending permission requests now survive WebSocket reconnect end-to-end:

1. **Server** re-delivers `permission.request` on `session.open` (already present) **and** on re-`auth.hello`.
2. **Server** live event fan-out: mid-turn events prefer the original socket, then any authenticated open client (so post-reconnect `tool.completed` / status still arrive).
3. **Mobile ChatScreen** re-`session.open` when connection status transitions back to `authenticated` while still on the chat screen.
4. **README** full Chinese quickstart (Node 20 / pnpm / API key / daemon / pairing / Expo / Android `10.0.2.2` / security).
5. **Tests** `reconnect.permission.test.ts` (3 cases).

---

## What was modified

| File | Change |
|---|---|
| `packages/agent/src/server.ts` | `resendAllPendingPermissions` on `auth.hello`; `authenticatedConns` + `pushLive` for reconnect-safe push; snapshot still embeds `pendingPermission` |
| `packages/agent/src/__tests__/reconnect.permission.test.ts` | Optional reconnect permission tests |
| `apps/mobile/src/screens/ChatScreen.tsx` | Re-open session on status → `authenticated` |
| `README.md` | Full Chinese quickstart |

### Server behavior

- **`session.open`**: `session.snapshot` (with `pendingPermission`) + `resendPendingPermission(ws, sessionId)`.
- **`auth.hello`**: `auth.ok` then `resendAllPendingPermissions(ws)` for every in-flight gate.
- **`permission.respond`** still resolves by `requestId` on any authenticated socket (map is process-local).
- Loop events use `pushLive(env, originWs)` so after the original WS closes, messages land on the reconnected client.

### Mobile behavior

```text
connStatus: * → authenticated  (while Chat focused / mounted)
  → openSession() → session.open → snapshot.pendingPermission + sheet
  (also listens for permission.request push from re-hello)
```

---

## Verification

```text
pnpm --filter @mobile-claude/agent test -- src/__tests__/reconnect.permission.test.ts
✓ 3 tests

pnpm test
packages/protocol: 2 passed
packages/agent: 81 passed (10 files)
Total: 83 passed

pnpm typecheck
protocol / agent / mobile: all exit 0
```

Manual MVP B checklist (spec §12) not run interactively in this agent environment (no paired phone / live Anthropic turn). Automated sandbox + permission + reconnect coverage is green.

---

## Security notes reflected in README

- Default bind `127.0.0.1`
- Do not expose port publicly
- API key host-only (`ANTHROPIC_API_KEY`)
- Android emulator host alias: `10.0.2.2`
