# Final branch review — fix report

Date: 2026-07-23  
Commit message: `fix: scrub bash env, abort pending perms, match request ids`  
(SHA recorded at delivery time in task response; do not embed self-referential SHA here.)

## Status

**GREEN** — `pnpm test` and `pnpm typecheck` all passed after fixes.

## Test / typecheck counts

| Check | Result |
|-------|--------|
| `packages/protocol` tests | 2 passed (1 file) |
| `packages/agent` tests | 89 passed (11 files) |
| **Total tests** | **91 passed** |
| `pnpm typecheck` | protocol + agent + mobile — all green |

## Must-fix items

### CRITICAL: Bash env scrub

**File:** `packages/agent/src/tools/bash.ts`

- Added exported `buildShellEnv(source?)` that:
  - Keeps only shell-relevant keys (PATH, SystemRoot, HOME, USERPROFILE, TEMP, TMP, LANG, COMSPEC, PATHEXT, etc.)
  - Strips `ANTHROPIC_API_KEY` and any key matching `/SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL/i`
- `spawnCollect` now uses `opts.env ?? buildShellEnv()` instead of full `process.env`
- Tests:
  - `buildShellEnv strips ANTHROPIC_API_KEY and secret-like keys`
  - `spawnCollect does not expose ANTHROPIC_API_KEY to the child env`

### HIGH: Abort while awaiting permission

**Files:** `packages/agent/src/server.ts`, `packages/agent/src/anthropic/loop.ts`

- `handleChatAbort`:
  1. Aborts the session `AbortController` first (so `raceAbort` rejects with aborted)
  2. Resolves all pending permissions for that session as `deny` and clears them
- `runAgentLoop` / `executeToolUse`: `onPermissionRequired` is wrapped in `raceAbort(promise, signal)` so `chat.abort` unblocks a stuck permission wait
- Test: `aborts while awaiting onPermissionRequired (does not hang)`

### HIGH: Mobile request matching by id

**File:** `apps/mobile/src/protocol/client.ts`

- `AgentClient.request` prefers `env.id === requestId` for expected types (server echoes id on fs replies, etc.)
- Errors match via `payload.replyTo === id` (or echoed id)
- Type-only fallback retained for handlers that do not echo request id yet (e.g. `auth.ok`, `session.list_result`)

## Optional (done)

### `/model` with no args

**Server:** `slash.run` `model` with empty args returns `status` with current session/default model (no validation error).  
**Mobile:** Chat local note shows current model + switch usage.

### `ConfigSetPayloadSchema.strict()`

**File:** `packages/protocol/src/messages.ts`  
- Schema is `.strict()` so unknown keys fail validation.  
- Server still pre-checks API-key smuggling fields and returns `forbidden` before schema parse.

## Files touched

- `packages/agent/src/tools/bash.ts`
- `packages/agent/src/anthropic/loop.ts`
- `packages/agent/src/server.ts`
- `packages/agent/src/__tests__/tools.sandbox.test.ts`
- `packages/agent/src/__tests__/loop.integration.test.ts`
- `apps/mobile/src/protocol/client.ts`
- `apps/mobile/src/screens/ChatScreen.tsx`
- `packages/protocol/src/messages.ts`
- `.superpowers/sdd/reports/final-fix-report.md` (this file)
