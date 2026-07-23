# Task 14 Report — Spec self-check hardening

**Status:** DONE  
**Date:** 2026-07-23  
**Commit message:** `test(agent): idempotency and output truncation`  
**SHA:** see `git log -1` after this report (committed together with implementation).

---

## Summary

Hardened three spec gaps from §4.1 / §4.4 / audit_log:

1. **`chat.send` idempotency** by envelope `id` (5 min window): mark accepted only after validation; silent ignore on duplicate id.
2. **Truncation flags**: `fs.read` already had `truncated`; tools now set `truncated: true` on capped output; `tool.completed` payload carries optional `truncated`.
3. **`audit_log`** writes on permission decisions (`auto_allow` / `allow_session_rule` / user `allow_once` | `allow_session` | `deny`).

---

## What was modified

| File | Change |
|---|---|
| `packages/agent/src/server.ts` | Accept-only chatIdem; pass `truncated` on `tool.completed` |
| `packages/agent/src/sessionStore.ts` | `appendAudit` / `listAudit` |
| `packages/agent/src/anthropic/loop.ts` | Audit on permission path; propagate `truncated` |
| `packages/agent/src/tools/input.ts` | `truncateText` + flag |
| `packages/agent/src/tools/{read,bash,grep,glob,write,edit,types}.ts` | Return `truncated` when capped |
| `packages/protocol/src/messages.ts` | `ToolCompletedPayload.truncated?` |
| `packages/agent/src/__tests__/chat.idempotency.test.ts` | New: duplicate id + not_found retriable |
| `packages/agent/src/__tests__/tools.sandbox.test.ts` | truncateText + Read truncated |
| `packages/agent/src/__tests__/server.routing.test.ts` | fs.read truncated:true |
| `packages/agent/src/__tests__/loop.integration.test.ts` | audit assertions |
| `packages/agent/src/__tests__/sessionStore.test.ts` | audit round-trip |

### Idempotency behavior

```text
chat.send (env.id)
  → prune map older than 5 min
  → if id already accepted → silent return
  → validate payload / session / busy / apiKey
  → on failure: error (id NOT cached — retriable)
  → on success: chatIdem.set(id, now) → run loop
```

### Truncation

- **fs.read**: `FsReadResult.truncated` (bytes) — already present; WS test covers it.
- **Tools**: `truncateText` → `ToolResult.truncated` → stored tool_run + `tool.completed.truncated`.

### Audit

```text
resolvePermission allow  → kind=permission decision=auto_allow | allow_session_rule
user permission.respond  → kind=permission decision=allow_once | allow_session | deny
```

---

## Verification

```text
pnpm test
packages/protocol: 2 passed (1 file)
packages/agent:     86 passed (11 files)
Total: 88 passed

pnpm typecheck
protocol / agent / mobile: all exit 0
```

New coverage added: chat.idempotency (2), tools truncate flags (2), fs.read truncated over WS, audit_log store + loop permission decisions.
