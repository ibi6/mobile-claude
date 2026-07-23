# Task 7 Report — WebSocket server + CLI entry

**Status:** DONE  
**Date:** 2026-07-23  
**Commit message:** `feat(agent): websocket server and CLI`

---

## Summary

Implemented the agent WebSocket daemon and CLI for `@mobile-claude/agent`: envelope routing for auth/session/chat/fs/config, permission pending map, loop integration, `fsApi` sandbox browse, and `mobile-claude-agent start` entry. Tests cover auth + session.list (and related routing) without an API key.

---

## What was created / modified

| File | Purpose |
|---|---|
| `packages/agent/src/server.ts` | `startServer(config)` — ws handlers, auth gate, chat loop bridge |
| `packages/agent/src/fsApi.ts` | `listWorkspaceDir` / `readWorkspaceFile` under workspace |
| `packages/agent/src/cli.ts` | `start --workspace --port --host --data-dir` |
| `packages/agent/src/index.ts` | Public package exports |
| `packages/agent/src/__tests__/server.routing.test.ts` | WS client routing tests (no API key) |
| `packages/agent/src/__tests__/fsApi.test.ts` | fs list/read/escape |
| `packages/agent/package.json` | bin `mobile-claude-agent`, deps `ws` + `@mobile-claude/protocol` |
| `README.md` | How to run the daemon |

### Interfaces

```ts
startServer(config, opts?): Promise<{
  close(): Promise<void>
  pairingCode: string
  port: number
  host: string
}>

// CLI
// mobile-claude-agent start --workspace <path> --port 7820 --host 127.0.0.1
```

### Handler map (implemented)

| type | behavior |
|---|---|
| `auth.pair` | pair → `auth.pair_result` + `auth.ok` |
| `auth.hello` | verify token; bad → error + close |
| `session.list/create/open/delete` | store + `session.list_result` / `session.snapshot` |
| `chat.send` | `runAgentLoop`; push delta/tool/status/permission events |
| `chat.abort` | AbortController per session |
| `permission.respond` | resolve pending `requestId` (5 min timeout → deny) |
| `slash.run` | `model` / `clear` |
| `fs.list` / `fs.read` | fsApi → `fs.list_result` / `fs.read_result` |
| `config.get` / `config.set` | model + autoAllowReadTools only; **never** API key |

Connection auth: until `auth.pair` or `auth.hello` succeeds, other types → `error` `unauthorized`.  
Default bind: `127.0.0.1`. API key only from host env / `StartServerOptions.apiKey`.

---

## TDD evidence

```text
pnpm --filter @mobile-claude/agent test

 ✓ src/__tests__/permissions.test.ts (17)
 ✓ src/__tests__/config.test.ts (3)
 ✓ src/__tests__/fsApi.test.ts (3)
 ✓ src/__tests__/paths.test.ts (10)
 ✓ src/__tests__/auth.test.ts (6)
 ✓ src/__tests__/sessionStore.test.ts (10)
 ✓ src/__tests__/server.routing.test.ts (7)
 ✓ src/__tests__/loop.integration.test.ts (7)
 ✓ src/__tests__/tools.sandbox.test.ts (15)

 Test Files  9 passed (9)
      Tests  78 passed (78)

pnpm --filter @mobile-claude/agent typecheck  → exit 0
pnpm --filter @mobile-claude/agent build      → exit 0
```

Routing tests (ws client): unauthorized gate, pair, hello + session.list empty, create + list, bad code, config no key / reject key over WS, fs.list/read.

---

## Self-review

| Check | Result |
|---|---|
| Files per brief | Yes |
| startServer + pairingCode | Yes |
| CLI start flags | Yes |
| Auth gate | Yes |
| Never API key over WS | Yes |
| Default 127.0.0.1 | Yes |
| Tests without API key | Yes |
| README daemon section | Yes |
| Commit message | `feat(agent): websocket server and CLI` |

---

## Concerns

1. Server→client types `fs.list_result`, `fs.read_result`, `config` are used but not in protocol `ServerMessageTypes` catalog yet — fine for v1; may formalize in protocol package later.
2. `config.set` is in-memory only (no write-back to `config.json`).
3. Full chat path needs `ANTHROPIC_API_KEY` on host; tests do not call the real API.
