# Task 6 Report — Anthropic agent loop

**Status:** DONE  
**Date:** 2026-07-23  
**Commit message:** `feat(agent): anthropic streaming tool loop`

---

## Summary

Implemented the Anthropic streaming tool loop for `@mobile-claude/agent`: mockable `streamMessage` client, `runAgentLoop` with permission gate + tool execution + persistence, and integration tests that never call the real API.

---

## What was created / modified

| File | Purpose |
|---|---|
| `packages/agent/src/anthropic/client.ts` | `createAnthropicClient`, `StreamMessageFn`, Anthropic message block types |
| `packages/agent/src/anthropic/loop.ts` | `runAgentLoop`, `LoopEvents`, `buildAnthropicMessages`, content_json docs |
| `packages/agent/src/__tests__/loop.integration.test.ts` | Mock multi-round stream tests |
| `packages/agent/src/sessionStore.ts` | `appendToolRun` / `updateToolRun` / `listToolRuns*` / `setTitle` |
| `packages/agent/package.json` | dependency `@anthropic-ai/sdk` |

### Interfaces

```ts
type LoopEvents = {
  onDelta(text, messageId)
  onToolStarted(...)
  onPermissionRequired(req): Promise<UserDecision>
  onToolCompleted(...)
  onDiff(...)
  onStatus(phase)
  onMessageCompleted(...)
}

runAgentLoop(args: {
  sessionId; store; config; userText; tools?; signal?; events;
  streamMessage?; apiKey?; maxRounds?
}): Promise<void>
```

### content_json (locked)

- user: `{ type: 'text', text }`
- assistant: `{ type: 'assistant', text, toolUses?: [{ id, name, input }] }`
- tool results: `tool_runs` rows linked by `message_id` → rebuilt as `tool_result` blocks

### Loop algorithm

1. Append user message (+ default title from first text)
2. Build Anthropic messages from store + tool_runs
3. Stream via injected `streamMessage` or real SDK
4. Text deltas → `onDelta`
5. `tool_use` → `resolvePermission` → ask → `onPermissionRequired` → deny error / allow → `runTool` → `onDiff` / `onToolCompleted` → persist tool_run
6. Continue rounds until text-only `end_turn` or abort / maxRounds

---

## TDD evidence

```text
pnpm --filter @mobile-claude/agent test

 ✓ src/__tests__/permissions.test.ts (17)
 ✓ src/__tests__/config.test.ts (3)
 ✓ src/__tests__/paths.test.ts (10)
 ✓ src/__tests__/auth.test.ts (6)
 ✓ src/__tests__/sessionStore.test.ts (10)
 ✓ src/__tests__/loop.integration.test.ts (7)
 ✓ src/__tests__/tools.sandbox.test.ts (15)

 Test Files  7 passed (7)
      Tests  68 passed (68)

pnpm --filter @mobile-claude/agent typecheck  → exit 0
pnpm --filter @mobile-claude/agent build      → exit 0
```

Brief-required mock case: fake stream yields `Write` tool_use → harness `allow_once` → file created in temp dir. Also covers text-only, deny, allow_session rule reuse, Read auto-allow, history mapping, AbortSignal.

---

## Implementation notes

1. **Mockability** — production uses `@anthropic-ai/sdk` `messages.stream`; tests inject `streamMessage` (no API key).
2. **Permissions** — reuses `resolvePermission` / `patternForTool` / `riskForTool`; `allow_session` writes `permission_rules`.
3. **Persistence** — assistant rows + `tool_runs` (`pending` → `completed` | `denied` | `error`).
4. **Safety** — `maxRounds` default 25; AbortSignal checked between stream/tool steps.

---

## Self-review

| Check | Result |
|---|---|
| Files per brief | Yes |
| Mock integration test | Yes |
| Permission gate + events | Yes |
| Persist messages/tool_runs | Yes |
| No real API key in tests | Yes |
| Typecheck / build | Yes |
| Commit message | `feat(agent): anthropic streaming tool loop` |

---

## Concerns

1. Real SDK path needs `ANTHROPIC_API_KEY` at process env or via `apiKey` arg — not loaded from config.json yet (Task 7 / host config).
2. `onMessageCompleted` fires on the final text-only assistant turn; intermediate tool-bearing turns are persisted but not completed events (UI can treat tool timeline separately).
3. If all rounds exhaust `maxRounds` after tools only, loop ends quietly with `status: idle` and no extra completed event — acceptable for v1.
