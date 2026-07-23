# Task 5 Report — Tool runners (Read/Write/Edit/Glob/Grep/Bash)

**Status:** DONE  
**Date:** 2026-07-23  
**Commit:** `240053a` — `feat(agent): sandboxed coding tools`

---

## Summary

Implemented sandboxed coding tool runners for `@mobile-claude/agent`: Read, Write, Edit, Glob, Grep, Bash, dispatched via `runTool`, with Anthropic-compatible JSON schemas from `anthropicToolDefinitions()`. All paths go through `assertInsideWorkspace`. No Anthropic loop or WebSocket.

---

## What was created

| File | Purpose |
|---|---|
| `packages/agent/src/tools/types.ts` | `ToolContext`, `ToolResult`, input types, limits |
| `packages/agent/src/tools/input.ts` | Input coercion + output truncation |
| `packages/agent/src/tools/diff.ts` | Unified diff helper for Write/Edit |
| `packages/agent/src/tools/read.ts` | Read with optional 1-indexed offset/limit |
| `packages/agent/src/tools/write.ts` | Write/overwrite + diff |
| `packages/agent/src/tools/edit.ts` | First-occurrence search-replace + diff |
| `packages/agent/src/tools/glob.ts` | Workspace glob (`fs.promises.glob` or fallback) |
| `packages/agent/src/tools/grep.ts` | Content search (`rg` if present, else TS walk) |
| `packages/agent/src/tools/bash.ts` | Shell spawn (powershell/bash/cmd), 60s timeout |
| `packages/agent/src/tools/registry.ts` | `runTool`, `anthropicToolDefinitions` |
| `packages/agent/src/tools/index.ts` | Public re-exports |
| `packages/agent/src/__tests__/tools.sandbox.test.ts` | Temp-workspace sandbox tests |

### Interfaces produced

- `type ToolContext = { workspaceRoot: string; shell: AgentConfig['shell']; signal?: AbortSignal }`
- `type ToolResult = { output: string; diff?: { path; unifiedDiff; before?; after? } }`
- `runTool(name, input, ctx): Promise<ToolResult>`
- `anthropicToolDefinitions(): AnthropicToolDefinition[]` (SDK-compatible shape, no SDK dep)

### Tool inputs (locked)

| Tool | Input |
|---|---|
| Read | `{ path, offset?, limit? }` |
| Write | `{ path, content }` |
| Edit | `{ path, old_string, new_string }` |
| Glob | `{ pattern }` |
| Grep | `{ pattern, path?, glob? }` |
| Bash | `{ command, cwd? }` |

---

## TDD evidence

```text
pnpm --filter @mobile-claude/agent test

 ✓ src/__tests__/permissions.test.ts (17 tests)
 ✓ src/__tests__/config.test.ts (3 tests)
 ✓ src/__tests__/paths.test.ts (10 tests)
 ✓ src/__tests__/auth.test.ts (6 tests)
 ✓ src/__tests__/sessionStore.test.ts (10 tests)
 ✓ src/__tests__/tools.sandbox.test.ts (10 tests)

 Test Files  6 passed (6)
      Tests  56 passed (56)

pnpm --filter @mobile-claude/agent typecheck  → exit 0
pnpm --filter @mobile-claude/agent build      → exit 0
```

Brief-required cases covered:
- Write + Read round trip
- Edit replaces once; missing `old_string` throws
- `../etc/passwd` Read → `PathEscapeError`
- Bash `echo` / `Write-Output hi` returns stdout (Windows PowerShell default)
- Bash cwd escape denied

Extra coverage: Read offset/limit, Glob, Grep, unknown tool, anthropicToolDefinitions ×6

---

## Implementation notes

1. **Sandbox** — every file path and Bash `cwd` uses `assertInsideWorkspace`; relative cwd resolves against workspace root.
2. **Bash** — `spawn(executable, args)` without `shell: true`; command is a single argv to `-Command` / `-c` / `/c`. Default shell on Windows is `powershell` from config types. Timeout 60s; output truncated at 200_000 chars with `\n[truncated]`.
3. **Edit** — first occurrence only; empty `old_string` rejected.
4. **Grep** — prefers `rg`; falls back to recursive TS regex walk (skips `node_modules`/`.git`, binary null-byte files).
5. **Glob** — Node 22 `fs.promises.glob` when available; else walk + minimal `*`/`**`/`?` matcher.
6. **Anthropic types** — local `AnthropicToolDefinition` avoids pulling `@anthropic-ai/sdk` in Task 5 (loop is Task 6).

---

## Self-review

| Check | Result |
|---|---|
| Matches brief file list | Yes |
| assertInsideWorkspace on paths | Yes |
| Bash timeout 60s / truncate 200k | Yes |
| Windows PowerShell default path | Yes (ctx.shell) |
| No Anthropic loop / WS | Yes |
| Tests pass | Yes (56/56) |
| Typecheck / build | Yes |
| Commit message | `feat(agent): sandboxed coding tools` |

---

## Concerns

1. **Unified diff is full-file hunk** — not a minimal Myers LCS; fine for agent UX until a richer diff is needed.
2. **Bash non-zero exit returns output with `[exit N]`** — does not throw, so the model can recover; callers that need fail-hard should parse the marker.
3. **Grep `rg` path** — relies on `rg` on PATH; silent fallback to TS if missing or error.

---

## HIGH findings fix (follow-up)

**Date:** 2026-07-23  
**Commit:** `fix(agent): bound tool output and kill bash trees`

### Changes

| Area | Fix |
|---|---|
| `bash.ts` | Cap stdout/stderr growth at `MAX_TOOL_OUTPUT_CHARS` during collection; on timeout/abort kill process tree (Windows: sync `taskkill /pid /T /F`); destroy streams when settled; still apply `truncateOutput`. Exported `spawnCollect` + `killChildProcessTree` for injectable short-timeout tests. |
| `grep.ts` | `GREP_TIMEOUT_MS` (60s) + `AbortSignal`; bounded rg/TS output; discard lines outside workspace (no raw escaped paths); skip files > `MAX_READ_BYTES`. |
| `edit.ts` / `write.ts` | Stat size check vs `MAX_READ_BYTES` before full read of existing file. |
| Tests | `truncateOutput` unit; `spawnCollect` 400ms timeout kill; Write/Edit path escape; Edit oversized file. |

### Verification

```text
pnpm --filter @mobile-claude/agent test

 ✓ src/__tests__/permissions.test.ts (17 tests)
 ✓ src/__tests__/config.test.ts (3 tests)
 ✓ src/__tests__/paths.test.ts (10 tests)
 ✓ src/__tests__/auth.test.ts (6 tests)
 ✓ src/__tests__/sessionStore.test.ts (10 tests)
 ✓ src/__tests__/tools.sandbox.test.ts (15 tests)

 Test Files  6 passed (6)
      Tests  61 passed (61)

pnpm --filter @mobile-claude/agent typecheck  → exit 0
pnpm --filter @mobile-claude/agent build      → exit 0
```
