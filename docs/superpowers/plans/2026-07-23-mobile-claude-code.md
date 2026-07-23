# Mobile Claude Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a phone remote console (Expo) + self-hosted Agent daemon (Node/TS) so a developer can chat, approve tools, view diffs, browse the workspace, and resume sessions — MVP B per the design spec.

**Architecture:** Monorepo with `packages/protocol` (Zod envelopes), `packages/agent` (WS server, SQLite sessions, Anthropic tool loop, permission gate, sandboxed tools), `apps/mobile` (Expo client). Phone never holds the API key; daemon is source of truth.

**Tech Stack:** pnpm workspaces, TypeScript, Node 20+, `ws`, `better-sqlite3` (or `sql.js` if native build fails on Windows), `@anthropic-ai/sdk`, Zod, Vitest, Expo SDK 52+, React Native, expo-secure-store, React Navigation.

**Spec:** `docs/superpowers/specs/2026-07-23-mobile-claude-code-design.md`

## Global Constraints

- Protocol envelope field `v` must be numeric `1`; bump only on breaking changes.
- Daemon default bind: `127.0.0.1` (not `0.0.0.0` unless CLI flag `--host` set).
- API key only via env `ANTHROPIC_API_KEY` or host config file — never accept key over WebSocket in v1.
- Path operations must `realpath` and stay under `workspaceRoot`.
- Default permission: Read/Glob/Grep auto-allow; Write/Edit/Bash require confirm.
- No Docker required for local dev (host Docker may be unavailable).
- UI language: Chinese primary copy for user-facing strings on mobile; code/comments English.
- Package names: `@mobile-claude/protocol`, `@mobile-claude/agent`, app name `mobile-claude`.
- Windows-first host OS; PowerShell default shell on win32.
- Commits: conventional commits; one logical commit per task after tests pass.
- Do not import or copy the Claude Code source dump into the monorepo; reimplement cleanly.

---

## File map (create during plan)

```
package.json
pnpm-workspace.yaml
tsconfig.base.json
.gitignore
README.md
packages/protocol/
  package.json
  tsconfig.json
  src/index.ts
  src/envelope.ts
  src/messages.ts
  src/parse.ts
  src/__tests__/envelope.test.ts
packages/agent/
  package.json
  tsconfig.json
  vitest.config.ts
  src/cli.ts
  src/config.ts
  src/db.ts
  src/auth.ts
  src/paths.ts
  src/server.ts
  src/sessionStore.ts
  src/permissions.ts
  src/anthropic/client.ts
  src/anthropic/loop.ts
  src/tools/types.ts
  src/tools/registry.ts
  src/tools/read.ts
  src/tools/write.ts
  src/tools/edit.ts
  src/tools/glob.ts
  src/tools/grep.ts
  src/tools/bash.ts
  src/fsApi.ts
  src/index.ts
  src/__tests__/paths.test.ts
  src/__tests__/permissions.test.ts
  src/__tests__/sessionStore.test.ts
  src/__tests__/tools.sandbox.test.ts
  src/__tests__/loop.integration.test.ts
apps/mobile/
  package.json
  app.json
  tsconfig.json
  App.tsx
  src/protocol/client.ts
  src/storage/secure.ts
  src/state/connection.ts
  src/state/sessions.ts
  src/screens/PairScreen.tsx
  src/screens/SessionsScreen.tsx
  src/screens/ChatScreen.tsx
  src/screens/FilesScreen.tsx
  src/screens/SettingsScreen.tsx
  src/components/MessageBubble.tsx
  src/components/ToolCard.tsx
  src/components/PermissionSheet.tsx
  src/components/DiffViewer.tsx
  src/theme.ts
  src/navigation.tsx
```

---

### Task 1: Monorepo scaffold + protocol package

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `README.md`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/src/envelope.ts`, `packages/protocol/src/messages.ts`, `packages/protocol/src/parse.ts`, `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/__tests__/envelope.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `PROTOCOL_VERSION = 1`
  - `createEnvelope(type, payload, opts?) → Envelope`
  - `parseEnvelope(raw: string) → Envelope` (throws `ProtocolError`)
  - Zod schemas / TS types for all MVP message payloads listed in spec §4.3
  - `type Envelope<T = unknown> = { v: 1; id: string; type: string; ts: number; sessionId?: string; payload: T }`

- [ ] **Step 1: Init workspace root**

Create `package.json`:

```json
{
  "name": "mobile-claude",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "build": "pnpm -r run build",
    "test": "pnpm -r run test",
    "typecheck": "pnpm -r run typecheck"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

Create `tsconfig.base.json` with `strict: true`, `module`/`moduleResolution` NodeNext, `target` ES2022.

Create `.gitignore`: `node_modules`, `dist`, `.expo`, `.env`, `*.db`, `.mobile-claude`.

- [ ] **Step 2: Write failing protocol test**

```ts
// packages/protocol/src/__tests__/envelope.test.ts
import { describe, it, expect } from 'vitest'
import { createEnvelope, parseEnvelope, PROTOCOL_VERSION } from '../index'

describe('envelope', () => {
  it('round-trips chat.send', () => {
    const env = createEnvelope('chat.send', { sessionId: 's1', text: 'hi' }, { sessionId: 's1' })
    expect(env.v).toBe(PROTOCOL_VERSION)
    expect(env.type).toBe('chat.send')
    const raw = JSON.stringify(env)
    const parsed = parseEnvelope(raw)
    expect(parsed.payload).toEqual({ sessionId: 's1', text: 'hi' })
  })

  it('rejects wrong version', () => {
    expect(() =>
      parseEnvelope(JSON.stringify({ v: 99, id: 'x', type: 'status', ts: 1, payload: {} }))
    ).toThrow(/version/i)
  })
})
```

- [ ] **Step 3: Run test — expect FAIL**

```bash
cd packages/protocol && pnpm exec vitest run
```

Expected: fail (package/modules missing).

- [ ] **Step 4: Implement protocol package**

`packages/protocol/package.json`: name `@mobile-claude/protocol`, type module, deps `zod`, devDeps `vitest`, `typescript`, scripts `build`/`test`/`typecheck`.

Implement:

```ts
// envelope.ts
import { z } from 'zod'
export const PROTOCOL_VERSION = 1 as const
export const EnvelopeSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  type: z.string().min(1),
  ts: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
  payload: z.unknown(),
})
export type Envelope<T = unknown> = Omit<z.infer<typeof EnvelopeSchema>, 'payload'> & { payload: T }

export function createEnvelope<T>(
  type: string,
  payload: T,
  opts?: { id?: string; sessionId?: string; ts?: number }
): Envelope<T> {
  return {
    v: 1,
    id: opts?.id ?? crypto.randomUUID(),
    type,
    ts: opts?.ts ?? Date.now(),
    sessionId: opts?.sessionId,
    payload,
  }
}
```

```ts
// parse.ts
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}
export function parseEnvelope(raw: string): Envelope {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new ProtocolError('invalid JSON')
  }
  const result = EnvelopeSchema.safeParse(data)
  if (!result.success) {
    if ((data as { v?: number })?.v !== 1) throw new ProtocolError('unsupported protocol version')
    throw new ProtocolError(result.error.message)
  }
  return result.data
}
```

In `messages.ts`, define Zod schemas for each payload type from the spec (at minimum: `AuthPairPayload`, `AuthHelloPayload`, `ChatSendPayload`, `PermissionRespondPayload`, `PermissionRequestPayload`, `MessageDeltaPayload`, `SessionSummary`, `ErrorPayload`, `FsListPayload`, `FsReadPayload`, `SlashRunPayload`, `ConfigGet/Set`). Export inferred types.

Export all from `index.ts`.

- [ ] **Step 5: Run tests — expect PASS**

```bash
pnpm --filter @mobile-claude/protocol test
```

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore README.md packages/protocol
git commit -m "feat: scaffold monorepo and protocol package"
```

---

### Task 2: Path sandbox utilities

**Files:**
- Create: `packages/agent/package.json`, `packages/agent/tsconfig.json`, `packages/agent/vitest.config.ts`
- Create: `packages/agent/src/paths.ts`
- Test: `packages/agent/src/__tests__/paths.test.ts`

**Interfaces:**
- Consumes: Node `fs`, `path`
- Produces:
  - `assertInsideWorkspace(workspaceRoot: string, userPath: string): string` — returns absolute real path or throws `PathEscapeError`
  - `toRelative(workspaceRoot: string, absPath: string): string`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertInsideWorkspace, PathEscapeError } from '../paths'

describe('assertInsideWorkspace', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ws-'))
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('allows relative path inside', () => {
    const abs = assertInsideWorkspace(root, 'a.txt')
    expect(abs).toBe(fs.realpathSync(path.join(root, 'a.txt')))
  })

  it('blocks .. escape', () => {
    expect(() => assertInsideWorkspace(root, '../outside')).toThrow(PathEscapeError)
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @mobile-claude/agent exec vitest run src/__tests__/paths.test.ts
```

- [ ] **Step 3: Implement `paths.ts`**

```ts
import fs from 'node:fs'
import path from 'node:path'

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathEscapeError'
  }
}

export function assertInsideWorkspace(workspaceRoot: string, userPath: string): string {
  const rootReal = fs.realpathSync(workspaceRoot)
  const candidate = path.isAbsolute(userPath)
    ? userPath
    : path.resolve(rootReal, userPath)
  // If file does not exist yet (Write), realpath parent
  let resolved: string
  try {
    resolved = fs.realpathSync(candidate)
  } catch {
    const parent = fs.realpathSync(path.dirname(candidate))
    resolved = path.join(parent, path.basename(candidate))
  }
  const rel = path.relative(rootReal, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathEscapeError(`path escapes workspace: ${userPath}`)
  }
  return resolved
}

export function toRelative(workspaceRoot: string, absPath: string): string {
  const rootReal = fs.realpathSync(workspaceRoot)
  return path.relative(rootReal, absPath).split(path.sep).join('/')
}
```

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/agent
git commit -m "feat(agent): path sandbox helpers"
```

---

### Task 3: Config, SQLite store, device auth

**Files:**
- Create: `packages/agent/src/config.ts`, `packages/agent/src/db.ts`, `packages/agent/src/auth.ts`, `packages/agent/src/sessionStore.ts`
- Test: `packages/agent/src/__tests__/sessionStore.test.ts`, extend auth in same or `auth.test.ts`

**Interfaces:**
- Consumes: paths optional
- Produces:
  - `loadConfig(): AgentConfig` — `{ host, port, workspaceRoot, dataDir, defaultModel, shell }`
  - `openDb(dataDir): Database`
  - `AuthService`: `createPairingCode()`, `pair(code, deviceName) → { deviceToken, deviceId }`, `verifyToken(token) → deviceId | null`, `hashToken(token)`
  - `SessionStore`: `list()`, `create(title?)`, `get(id)`, `delete(id)`, `appendMessage(...)`, `listMessages(sessionId)`, `setModel(sessionId, model)`, `clearMessages(sessionId)`, permission rule CRUD

**AgentConfig type:**

```ts
export type AgentConfig = {
  host: string // default 127.0.0.1
  port: number // default 7820
  workspaceRoot: string
  dataDir: string
  defaultModel: string
  shell: 'powershell' | 'bash' | 'cmd'
  autoAllowReadTools: boolean // default true
  pairingCodeTtlMs: number // 600_000
}
```

- [ ] **Step 1: Write sessionStore tests** using temp dataDir — create session, append user/assistant messages, list ordered, clearMessages keeps session id, permission rule allow_session lookup.

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement**

Use `better-sqlite3` if install works; if native compile fails on user machine, switch to `sql.js` with file persist and note in README.

Schema SQL (run on open):

```sql
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  sort_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS tool_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS permission_rules (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  pattern TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
```

`AuthService.pair`: validate code not expired, delete code, generate `deviceToken = randomBytes(32).toString('base64url')`, store `sha256(token)`, return raw token once.

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agent): config, sqlite store, device pairing auth"
```

---

### Task 4: Permission gate

**Files:**
- Create: `packages/agent/src/permissions.ts`
- Test: `packages/agent/src/__tests__/permissions.test.ts`

**Interfaces:**
- Produces:
  - `type PermissionDecision = 'allow' | 'ask'`
  - `type UserDecision = 'allow_once' | 'allow_session' | 'deny'`
  - `resolvePermission({ tool, pattern, sessionId, autoAllowReadTools, rules }): PermissionDecision`
  - `patternForTool(tool, input): string` — file path or exact bash command
  - `riskForTool(tool): 'low' | 'medium' | 'high'`

Rules:

```ts
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])
export function resolvePermission(args: {
  tool: string
  pattern: string
  autoAllowReadTools: boolean
  rules: { tool: string; pattern: string }[]
}): 'allow' | 'ask' {
  if (args.rules.some(r => r.tool === args.tool && r.pattern === args.pattern)) return 'allow'
  if (args.autoAllowReadTools && READ_TOOLS.has(args.tool)) return 'allow'
  return 'ask'
}
```

- [ ] **Step 1: Tests** — auto-allow Read; ask Write; allow when session rule matches exact path; Bash never auto.

- [ ] **Step 2: Implement + PASS + commit**

```bash
git commit -m "feat(agent): permission resolution gate"
```

---

### Task 5: Tool runners (Read/Write/Edit/Glob/Grep/Bash)

**Files:**
- Create: `packages/agent/src/tools/*.ts`, `packages/agent/src/tools/registry.ts`, `packages/agent/src/tools/types.ts`
- Test: `packages/agent/src/__tests__/tools.sandbox.test.ts`

**Interfaces:**
- Produces:
  - `type ToolContext = { workspaceRoot: string; shell: AgentConfig['shell']; signal?: AbortSignal }`
  - `type ToolResult = { output: string; diff?: { path: string; unifiedDiff: string; before?: string; after?: string } }`
  - `runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>`
  - `anthropicToolDefinitions(): Anthropic.Tool[]` — JSON schemas for the six tools

**Tool input shapes (lock these):**

| Tool | Input |
|---|---|
| Read | `{ path: string, offset?: number, limit?: number }` |
| Write | `{ path: string, content: string }` |
| Edit | `{ path: string, old_string: string, new_string: string }` |
| Glob | `{ pattern: string }` |
| Grep | `{ pattern: string, path?: string, glob?: string }` |
| Bash | `{ command: string, cwd?: string }` |

- [ ] **Step 1: Write tests** in temp workspace:
  - Write + Read round trip
  - Edit replaces once; missing old_string throws
  - `../etc/passwd` Read throws PathEscapeError
  - Bash `echo hi` returns stdout (skip if CI without shell — still run on Windows PowerShell)
  - Bash cwd escape denied

- [ ] **Step 2: Implement tools** using `assertInsideWorkspace`. Bash: `spawn` with `shell: true` carefully — prefer `spawn(shellExecutable, args)` without string concat injection; pass command as single arg to `-Command` / `-c`. Timeout 60s. Truncate output at 200_000 chars with suffix `\n[truncated]`.

- [ ] **Step 3: Tests PASS + commit**

```bash
git commit -m "feat(agent): sandboxed coding tools"
```

---

### Task 6: Anthropic agent loop (text + tools + permissions hooks)

**Files:**
- Create: `packages/agent/src/anthropic/client.ts`, `packages/agent/src/anthropic/loop.ts`
- Test: `packages/agent/src/__tests__/loop.integration.test.ts` with **mock** fetch/SDK

**Interfaces:**
- Produces:
  - `type LoopEvents = { onDelta(text, messageId); onToolStarted(...); onPermissionRequired(req): Promise<UserDecision>; onToolCompleted(...); onDiff(...); onStatus(phase); onMessageCompleted(...) }`
  - `runAgentLoop(args: { sessionId; store; config; userText; tools; signal; events }): Promise<void>`

Loop algorithm:

1. Append user message to store.
2. Build Anthropic messages from store (map tool_runs into tool_use/tool_result blocks as needed — keep a simple content_json format documented in code).
3. Stream `messages.stream` with tools.
4. On text → onDelta.
5. On tool_use → resolvePermission → if ask, await onPermissionRequired → deny synthesizes tool_result error string → if allow, runTool → onDiff if any → append tool_result → continue stream/request until stop.
6. Persist assistant message + tool runs.

**content_json format (lock):**

```ts
// user
{ type: 'text', text: string }
// assistant
{ type: 'assistant', text: string, toolUses?: { id: string, name: string, input: unknown }[] }
// tool result row linked via tool_runs
```

Mock test: fake stream yields tool_use Write → test harness auto `allow_once` → file created in temp dir.

- [ ] **Step 1: Failing integration test with mock**
- [ ] **Step 2: Implement client + loop**
- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(agent): anthropic streaming tool loop"
```

---

### Task 7: WebSocket server + CLI entry

**Files:**
- Create: `packages/agent/src/server.ts`, `packages/agent/src/fsApi.ts`, `packages/agent/src/cli.ts`, `packages/agent/src/index.ts`
- Modify: `packages/agent/package.json` bin: `mobile-claude-agent`

**Interfaces:**
- Produces:
  - `startServer(config): { close(): Promise<void>; pairingCode: string }`
  - CLI: `node dist/cli.js start --workspace <path> --port 7820 --host 127.0.0.1`

**Handler map:**

| type | behavior |
|---|---|
| `auth.pair` | AuthService.pair → `auth.ok`-like result envelope (or dedicated `auth.pair_result`) |
| `auth.hello` | verify token; fail close if bad |
| `session.*` | SessionStore + `session.list_result` / `session.snapshot` |
| `chat.send` | runAgentLoop; push events to this socket |
| `chat.abort` | AbortController per session |
| `permission.respond` | resolve pending Promise in map `requestId → resolver` |
| `slash.run` | model/clear |
| `fs.list` / `fs.read` | fsApi under workspace |
| `config.get` / `config.set` | model default, autoAllowReadTools — never return API key |

Pending permissions: `Map<string, { resolve }>` + re-send on session.open.

Connection auth: until `auth.hello` or `auth.pair` succeeds, reject other types with `unauthorized`.

- [ ] **Step 1: Manual script test** (or vitest with `ws` client):
  1. startServer with temp workspace
  2. pair
  3. create session
  4. chat.send with mock loop or skip if no API key — gate real API behind `process.env.ANTHROPIC_API_KEY`

Without API key, unit-test message routing only (auth + session.list).

- [ ] **Step 2: Implement server + CLI**
- [ ] **Step 3: Document in README how to run daemon**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(agent): websocket server and CLI"
```

---

### Task 8: Mobile app scaffold + theme + secure storage

**Files:**
- Create: Expo app under `apps/mobile` via `pnpm create expo-app` (template blank-typescript), then add deps
- Create: `apps/mobile/src/theme.ts`, `apps/mobile/src/storage/secure.ts`, `apps/mobile/src/navigation.tsx`, `App.tsx`

**Interfaces:**
- Produces:
  - `theme` colors: purple/indigo gradient tokens
  - `saveConnection({ host, port, deviceToken })`, `loadConnection()`, `clearConnection()`
  - Navigation: Pair | Main (Sessions stack + Chat + Files + Settings)

- [ ] **Step 1: Scaffold Expo app**, add packages: `@react-navigation/native`, native-stack, `expo-secure-store`, `expo-linear-gradient`, `zod`, workspace protocol via `"@mobile-claude/protocol": "workspace:*"`

Note: Metro must resolve workspace package — add `watchFolders` / `nodeModulesPaths` in `metro.config.js` for monorepo.

- [ ] **Step 2: Implement theme + secure storage + empty screens shells**
- [ ] **Step 3: Run `pnpm --filter mobile-claude typecheck` or `npx tsc --noEmit`**
- [ ] **Step 4: Commit**

```bash
git commit -m "feat(mobile): expo scaffold, theme, secure storage"
```

---

### Task 9: Mobile WS client + Pair + Sessions screens

**Files:**
- Create: `apps/mobile/src/protocol/client.ts`, `apps/mobile/src/state/connection.ts`, `apps/mobile/src/state/sessions.ts`, `apps/mobile/src/screens/PairScreen.tsx`, `apps/mobile/src/screens/SessionsScreen.tsx`

**Interfaces:**
- Produces:
  - `class AgentClient { connect(); send(type, payload); on(type, handler); disconnect() }`
  - Auto-reconnect with backoff; re-`auth.hello` after open
  - PairScreen → saves token → navigates Sessions
  - SessionsScreen lists from `session.list`, FAB `session.create`, tap → Chat

```ts
// client.ts core
export class AgentClient {
  private ws?: WebSocket
  private handlers = new Map<string, Set<(env: Envelope) => void>>()
  constructor(private opts: { host: string; port: number; deviceToken?: string }) {}
  connect(): Promise<void> { /* ws://host:port */ }
  send(type: string, payload: unknown, sessionId?: string): string {
    const env = createEnvelope(type, payload, { sessionId })
    this.ws!.send(JSON.stringify(env))
    return env.id
  }
  on(type: string, cb: (env: Envelope) => void): () => void { /* unsubscribe */ }
}
```

Use React state/context `ConnectionProvider` holding client singleton.

- [ ] **Step 1: Implement client + pair/session UI**
- [ ] **Step 2: Manual test against local daemon (Task 7)**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mobile): pair flow and session list"
```

---

### Task 10: Chat UI + streaming + tool cards + abort

**Files:**
- Create: `apps/mobile/src/screens/ChatScreen.tsx`, `apps/mobile/src/components/MessageBubble.tsx`, `apps/mobile/src/components/ToolCard.tsx`

**Behavior:**
- On focus: `session.open` → apply `session.snapshot`
- Composer sends `chat.send`
- Listen `message.delta` append to assistant bubble
- `tool.started/completed` render ToolCard in timeline
- Stop button → `chat.abort`
- Header status from `status` events

- [ ] **Step 1: Implement Chat + components**
- [ ] **Step 2: E2E manual with API key: “list files in workspace”**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mobile): chat streaming and tool cards"
```

---

### Task 11: Permission sheet + Diff viewer

**Files:**
- Create: `apps/mobile/src/components/PermissionSheet.tsx`, `apps/mobile/src/components/DiffViewer.tsx`
- Modify: `ChatScreen.tsx`

**Behavior:**
- On `permission.request` → present modal (not dismissible by backdrop while pending)
- Buttons: 拒绝 / 允许一次 / 本会话允许 → `permission.respond`
- On `diff.available` → chip on ToolCard opens DiffViewer modal (unified diff monospace)

- [ ] **Step 1: Implement**
- [ ] **Step 2: Manual: agent tries Write → sheet → allow → file on disk**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mobile): permission sheet and diff viewer"
```

---

### Task 12: Files tab + Settings + slash commands

**Files:**
- Create: `apps/mobile/src/screens/FilesScreen.tsx`, `apps/mobile/src/screens/SettingsScreen.tsx`
- Modify: Chat composer to detect `/model`, `/clear` → `slash.run` instead of `chat.send` when message matches `^/(model|clear)(\\s|$)`

**FilesScreen:**
- `fs.list` on `.` then navigate subdirs
- Tap file → `fs.read` preview (text only; binary show “二进制文件”)

**Settings:**
- Connection info, workspace path from `auth.ok`/`config.get`
- Toggle auto-allow reads → `config.set`
- Disconnect clears SecureStore

- [ ] **Step 1: Implement**
- [ ] **Step 2: Manual verify file tree + /clear + /model**
- [ ] **Step 3: Commit**

```bash
git commit -m "feat(mobile): files browser, settings, slash commands"
```

---

### Task 13: Reconnect pending permissions + polish + README

**Files:**
- Modify: `packages/agent/src/server.ts` (pending redelivery), mobile client reconnect
- Modify: `README.md` full quickstart
- Optional: `packages/agent/src/__tests__/reconnect.permission.test.ts`

**README sections (Chinese):**
1. 前置：Node 20、pnpm、Anthropic API Key
2. 安装 `pnpm install`
3. 启动 daemon：`pnpm --filter @mobile-claude/agent start -- --workspace <路径>`
4. 记下 pairing code
5. 启动 Expo：`pnpm --filter mobile-claude start`
6. 手机与电脑同网或 Tailscale；Android 模拟器用 `10.0.2.2` 访问宿主 `127.0.0.1`
7. 安全警告：勿把端口裸奔公网

- [ ] **Step 1: Implement pending permission redelivery on `session.open` / re-hello**
- [ ] **Step 2: Full manual MVP B checklist from spec §12 exit criteria**
- [ ] **Step 3: Run full test suite `pnpm test`**
- [ ] **Step 4: Commit**

```bash
git commit -m "docs: quickstart and reconnect permission polish"
```

---

### Task 14: Spec self-check hardening

**Files:**
- Add any missing tests for audit_log write on permission decisions
- Ensure `chat.send` idempotency by envelope `id` (5 min window) in server
- Truncation flags on large `fs.read` / tool output

- [ ] **Step 1: Add tests for idempotent chat.send**
- [ ] **Step 2: Implement if missing**
- [ ] **Step 3: `pnpm test && pnpm typecheck` all green**
- [ ] **Step 4: Commit**

```bash
git commit -m "test(agent): idempotency and output truncation"
```

---

## Plan self-review (vs spec)

| Spec area | Task coverage |
|---|---|
| Monorepo layout | Task 1, 8 |
| Protocol v1 envelopes | Task 1 |
| Pairing + device token | Task 3, 7, 9 |
| Sessions list/create/open/delete | Task 3, 7, 9 |
| Streaming chat | Task 6, 7, 10 |
| Tools ×6 + sandbox | Task 2, 5 |
| Permissions once/session/deny | Task 4, 6, 11 |
| Diff on Write/Edit | Task 5, 6, 11 |
| File tree + preview | Task 7 fsApi, 12 |
| /model /clear | Task 7, 12 |
| Settings auto-allow reads | Task 7, 12 |
| API key host-only | Task 3, 7 (enforced) |
| Bind 127.0.0.1 | Task 7 CLI |
| Reconnect pending permission | Task 13 |
| Tests | Tasks 1–6, 14 |
| Non-goals (MCP, bridge…) | Not scheduled — OK |

**Placeholder scan:** none intentional.  
**Type consistency:** Envelope, tool names, UserDecision, AgentConfig aligned across tasks.

---

## Execution notes

- Prefer **subagent-driven-development**: one task per subagent, run tests before merge to main thread.
- If `better-sqlite3` fails to build on Windows, switch Task 3 to `sql.js` in the same task — do not block the plan.
- Expo app folder name in package.json should be `mobile-claude` to match filter scripts.
- Do not commit API keys or pairing secrets.
