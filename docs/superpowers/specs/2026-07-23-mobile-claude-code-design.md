# Mobile Claude Code — Design Spec

**Date:** 2026-07-23  
**Status:** Draft for user review  
**Product name (working):** Mobile Claude Code（远程控制台）  
**Workspace:** `mobile claude`  
**Reference source:** Claude Code CLI export (Ink/React TUI) — **inspiration only**, not a port

---

## 1. Problem & goal

Claude Code is a terminal coding agent: multi-turn chat, tool loop (read/edit/bash/search), permission gates, and project-aware context. Phones cannot host a full development workspace safely or ergonomically.

**Goal:** A **mobile remote console** that drives a **self-hosted Agent daemon** on a PC/VPS, so the user can chat, approve tools, browse the project, and resume sessions from a phone — with interaction quality closer to a product app than an SSH terminal.

**Non-goal (v1):** 1:1 clone of desktop Claude Code (MCP marketplace, swarms, full slash set, official claude.ai bridge, Ink UI reuse).

---

## 2. Decisions locked (user + recommended defaults)

| Decision | Choice |
|---|---|
| Product form | **A — Remote console** (UI on phone, execution on remote) |
| Remote runtime | **Self-built Agent daemon** (not wrapping official CLI PTY) |
| MVP scope | **B — Workflow-enhanced** |
| Mobile stack | **Expo (React Native) + TypeScript** |
| Daemon stack | **Node.js 20+ / TypeScript** |
| Shared contract | **`packages/protocol`** with Zod schemas, `v: 1` |
| Model access | User-supplied **Anthropic API key**, stored **only on daemon** |
| Network default | Daemon binds **`127.0.0.1`**; LAN/Tailscale for phone; optional later: TLS reverse proxy |
| UI style | Clean SaaS: soft gradients, large radius, purple–indigo accents |

---

## 3. Architecture

```
┌─────────────────────┐         WebSocket + JSON          ┌──────────────────────────┐
│  apps/mobile        │  ◄──────────────────────────────► │  packages/agent          │
│  Expo RN client     │   auth · sessions · chat stream   │  Agent daemon            │
│                     │   tools · permissions · fs        │                          │
│  - Chat / Tools UI  │                                   │  - Session + SQLite      │
│  - Permission sheet │                                   │  - Anthropic SDK stream  │
│  - File tree/diff   │                                   │  - Tool runners          │
│  - Session list     │                                   │  - Permission gate       │
└─────────────────────┘                                   │  - Workspace sandbox     │
                                                          └────────────┬─────────────┘
                                                                       │
                                                                       ▼
                                                          Anthropic API · local FS · shell
```

### Monorepo layout

```
mobile-claude/
  apps/mobile/                 # Expo app
  packages/protocol/           # Shared types + Zod + frame helpers
  packages/agent/              # Daemon CLI + server
  docs/superpowers/specs/      # This design + later plans
  package.json                 # pnpm workspace root
  pnpm-workspace.yaml
  README.md
```

### Component boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `protocol` | Frame types, event names, validation, versioning | zod only |
| `agent` | Auth, sessions, LLM loop, tools, FS, permissions, persistence | protocol, anthropic, ws, sqlite |
| `mobile` | Screens, local cache, WS client, presentation | protocol only (no agent imports) |

Rules:

- Mobile **never** executes tools or holds the API key long-term.
- Agent is the **source of truth** for sessions and permissions.
- Protocol is the **only** cross-process contract; bump `v` on breaking changes.

---

## 4. Protocol

### 4.1 Transport

- WebSocket, text frames, JSON body.
- Optional first message: HTTP-style query `?token=` only for pairing bootstrap; prefer subprotocol header or first JSON `auth.*` message.
- Heartbeat: client or server `ping` every 30s; 90s without pong → reconnect.
- Max frame payload: 2 MiB; larger tool outputs truncated server-side with `truncated: true`.

### 4.2 Envelope

```ts
type Envelope<T = unknown> = {
  v: 1
  id: string           // uuid
  type: string
  ts: number           // unix ms
  sessionId?: string   // when scoped to a session
  payload: T
}
```

Errors:

```ts
type ErrorPayload = {
  code:
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'validation'
    | 'busy'
    | 'aborted'
    | 'upstream'      // Anthropic / network
    | 'tool_failed'
    | 'internal'
  message: string      // safe for UI
  details?: unknown    // never secrets
  replyTo?: string
}
```

### 4.3 Message catalog (MVP B)

**Client → Server**

| type | payload (summary) |
|---|---|
| `auth.pair` | `{ code: string, deviceName: string }` → returns `deviceToken` |
| `auth.hello` | `{ deviceToken: string, clientVersion: string }` |
| `session.list` | `{}` |
| `session.create` | `{ title?: string }` |
| `session.open` | `{ sessionId: string }` |
| `session.delete` | `{ sessionId: string }` |
| `chat.send` | `{ sessionId, text: string }` |
| `chat.abort` | `{ sessionId }` |
| `slash.run` | `{ sessionId, command: 'model' \| 'clear', args?: string }` |
| `permission.respond` | `{ requestId, decision: 'allow_once' \| 'allow_session' \| 'deny' }` |
| `fs.list` | `{ path: string }` relative to workspace |
| `fs.read` | `{ path: string, maxBytes?: number }` text preview only |
| `config.get` | `{}` |
| `config.set` | `{ model?: string, autoAllowReadTools?: boolean }` — **never** accepts API key over WS in v1 (key via env/file on host only) |

**Server → Client**

| type | payload (summary) |
|---|---|
| `auth.ok` | `{ deviceId, workspaceRoot, serverVersion }` |
| `session.list_result` | `{ sessions: SessionSummary[] }` |
| `session.snapshot` | full resume payload (messages + pending permission + status) |
| `message.delta` | `{ messageId, role: 'assistant', text: string }` |
| `message.completed` | `{ messageId, stopReason }` |
| `tool.started` | `{ toolRunId, name, inputSummary, input }` |
| `tool.progress` | `{ toolRunId, text?: string }` optional |
| `tool.completed` | `{ toolRunId, status, outputSummary, output? }` |
| `permission.request` | `{ requestId, toolRunId, name, input, risk: 'low'\|'medium'\|'high' }` |
| `diff.available` | `{ toolRunId, path, before?, after?, unifiedDiff }` |
| `status` | `{ phase: 'idle'\|'thinking'\|'tool'\|'awaiting_permission', model, busy: boolean }` |
| `error` | `ErrorPayload` |

### 4.4 Idempotency

- `chat.send` with duplicate client `id` within 5 minutes is ignored if already accepted.
- `permission.respond` for unknown/expired `requestId` → `error` `not_found`.

---

## 5. Permission model

### 5.1 Defaults (optimal for safety + usability)

| Tool | Default |
|---|---|
| `Read`, `Glob`, `Grep` | **Auto-allow** (audit log kept) |
| `Write`, `Edit` | **Confirm every time** |
| `Bash` | **Confirm every time** (no auto-heuristic in v1) |

`config.set.autoAllowReadTools = false` forces confirm on read tools too.

### 5.2 Decisions

| Decision | Effect |
|---|---|
| `allow_once` | Run this tool call only |
| `allow_session` | Store session rule: same tool + path/command pattern match |
| `deny` | Return synthetic tool error to model; turn may continue |

**No global “bypass all permissions”** in v1 UI (reduces foot-guns). Power users can still auto-allow read tools via config.

### 5.3 Pattern matching for `allow_session`

- File tools: normalize path relative to workspace; rule key = `tool + path` (exact) or `tool + directory prefix` if path is under a previously allowed directory for that tool — **v1: exact path only** (simpler, safer).
- Bash: rule key = `tool + exact command string` only (no fuzzy).

### 5.4 State machine

```
tool_use received
  → resolve rules (session store)
  → if allowed: execute → tool.completed → continue agent loop
  → else: permission.request, session phase = awaiting_permission
       → respond allow_* → execute → continue
       → deny / timeout (5 min) → tool.completed(status=denied) → continue loop
```

Pending permission requests survive WebSocket reconnect; on `session.open` / re-`auth.hello`, server re-sends pending `permission.request`.

### 5.5 Sandbox

- Single `workspaceRoot` per daemon process (config file / CLI flag).
- All paths `realpath`’d and must stay under `workspaceRoot`.
- Bash: `cwd` defaults to workspaceRoot; block if resolved cwd escapes.
- Bash timeout default 60s; max output 200KB to model + clients.
- No network-install elevating tools in v1 beyond what user shell already can do — document risk in README.

---

## 6. Agent loop (daemon)

1. Load session messages from SQLite.
2. Call Anthropic Messages API with tools schema (stream).
3. On text deltas → `message.delta`.
4. On `tool_use` → permission gate → execute → append `tool_result` → loop until end_turn or abort.
5. Persist each completed message / tool_run.
6. Title: first user message truncated, or model-generated later (v1: truncate).

### Tools (v1)

| Name | Behavior |
|---|---|
| `Read` | Read file, line range optional, max size cap |
| `Write` | Create/overwrite file; emit diff vs previous if existed |
| `Edit` | Search-replace or patch-style edit; emit unified diff |
| `Glob` | File pattern under workspace |
| `Grep` | Ripgrep-like content search (use `ripgrep` binary if present, else TS fallback) |
| `Bash` | Shell command with sandbox constraints |

System prompt: coding agent over `workspaceRoot`, concise, respect permission denials, prefer dedicated tools over bash for file ops.

### Slash commands (v1)

| Command | Behavior |
|---|---|
| `/clear` | New empty transcript in same session (or archive + reset); keep session id |
| `/model` | Show current model; `/model <name>` sets session model if allowed list |

Allowed models: configurable list defaulting to current Anthropic coding models (e.g. `claude-sonnet-4-...` as configured in env `DEFAULT_MODEL`).

---

## 7. Persistence (daemon)

SQLite file default: `~/.mobile-claude/data.db` (Windows: `%USERPROFILE%\.mobile-claude\data.db`).

**Tables (logical):**

- `devices` — deviceToken hash, name, created_at  
- `sessions` — id, title, model, created_at, updated_at  
- `messages` — id, session_id, role, content_json, created_at, sort_index  
- `tool_runs` — id, session_id, message_id, name, input_json, output_json, status, created_at  
- `permission_rules` — id, session_id, tool, pattern, created_at  
- `audit_log` — optional append-only tool/permission events  

Secrets:

- API key: env `ANTHROPIC_API_KEY` or `~/.mobile-claude/config.json` with file permissions warning on Windows.
- Device tokens: store **hash** server-side; raw token only shown once at pair time.

---

## 8. Mobile client IA

### Screens

1. **Onboarding / Pair** — host, port, pairing code, device name  
2. **Sessions** — list, pull-to-refresh, FAB new session, swipe delete  
3. **Chat** — message list, streaming bubble, tool timeline cards, composer, abort  
4. **Permission sheet** — modal: tool summary, expandable input, Deny / Once / This session  
5. **Diff viewer** — from tool card or notification chip  
6. **Files** — tree from workspace root, file preview (text)  
7. **Settings** — connection status, model shortcut, auto-allow reads toggle (calls `config.set`), disconnect/re-pair  

### Navigation

- Root: auth gate → Sessions stack  
- Session open → Chat (tab or header actions: Files, Settings)  

### Local state

- SecureStore: `deviceToken`, `host`, `port`  
- In-memory + lightweight cache: current session messages (reconcile on snapshot)  
- Optimistic user message bubble; roll back on hard error  

### UX notes (from Claude Code inspiration)

- Tool cards show name + short input summary; expand for full JSON/output  
- While `awaiting_permission`, composer disabled or secondary; sheet auto-presents  
- Status chip: model + phase  
- Empty session: short tips (what this app is / needs daemon running)

---

## 9. Daemon CLI UX

```bash
# install / run (exact scripts finalized in implementation plan)
pnpm --filter @mobile-claude/agent start -- --workspace D:\proj --port 7820

# first run prints pairing code
# config path: ~/.mobile-claude/config.json
```

Commands:

- `start` — run server  
- `pair-reset` — invalidate devices / new code  
- `status` — show port, workspace, device count (no secrets)

---

## 10. Security checklist (v1)

- [x] API key never sent to mobile  
- [x] Default bind 127.0.0.1  
- [x] Token auth on every connection  
- [x] Path confinement under workspaceRoot  
- [x] Write/Bash gated by default  
- [x] Output truncation  
- [x] No secret echo in errors or logs  
- [ ] TLS — deferred (use Tailscale/SSH tunnel for remote)  
- [ ] Multi-workspace switcher — deferred  

---

## 11. Testing strategy

| Layer | What |
|---|---|
| `protocol` | Zod round-trip, reject unknown/breaking shapes |
| `agent` unit | Path sandbox, permission matcher, session CRUD |
| `agent` integration | Mock Anthropic stream → tool_use → permission → execute (temp dir) |
| `mobile` | WS client reconnect + permission response mapping (unit); manual device smoke |

CI: typecheck + unit/integration on agent/protocol; mobile typecheck.

---

## 12. Implementation phases

### Phase 0 — Scaffold

- pnpm workspace, protocol package, empty agent + expo app, README

### Phase 1 — Daemon core

- Config, SQLite, WS server, pair/hello, session CRUD, Anthropic stream text-only chat

### Phase 2 — Tools + permissions

- Six tools, permission gate, diffs for write/edit, abort

### Phase 3 — Mobile MVP A parity

- Pair, sessions, chat stream, tool cards, permission sheet

### Phase 4 — MVP B extras

- File tree + preview, session resume polish, `/model` `/clear`, settings, allow_session rules UI feedback

### Phase 5 — Hardening

- Tests, truncation edge cases, reconnect pending permissions, basic audit log

**Exit criteria for “MVP B done”:**

1. Phone pairs to daemon on same machine/Tailscale  
2. Multi-turn coding task with Read + Edit + Bash approvals works  
3. Diff visible after Edit  
4. Files tab browses workspace  
5. Kill app, reopen, resume same session  
6. `/model` and `/clear` work  
7. Automated tests for sandbox + permissions pass  

---

## 13. Explicit non-goals (v1)

- Official Anthropic remote-control / bridge protocol compatibility  
- MCP servers, plugins, skills marketplace  
- Multi-agent / team / plan-mode product surface  
- Full slash command parity  
- PowerShell-specific tool (Bash/cmd via Bash tool is enough on Windows for v1; document `shell` choice)  
- App Store release pipeline (local/dev client first)  
- Dockerized daemon as requirement (optional later; local Node is default — host Docker may be unavailable)

---

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Users expose port to public internet | Default localhost; README warns; optional bind flag documented |
| Bash can still damage workspace | Confirm every bash; path cwd lock; timeout |
| Partial Claude Code source incomplete | Reimplement loop cleanly; don’t import broken dump |
| Mobile background WS drops | Snapshot on resume; pending permission redelivery |
| Model/tool API drift | Pin SDK version; single adapter module |

---

## 15. Open points fixed by “optimal defaults”

User deferred remaining choices; locked as follows:

- Read tools auto-allow: **yes**  
- `allow_always` global write bypass: **no** in v1  
- Grep implementation: ripgrep if available else fallback  
- Windows shell: default `cmd.exe` / `powershell` selectable in config, default **powershell** on Windows, **bash** elsewhere  
- Pairing code TTL: **10 minutes**, single use  
- Max concurrent sessions generating: **1 per session**, multiple sessions idle ok; global **2** concurrent generations  

---

## 16. Success definition

A developer can leave home, open the phone app, continue a repo session on their always-on PC, approve file edits and shell commands with clear diffs, and not need SSH or a desktop window for the common “nudge the agent / approve the next step” workflow.
