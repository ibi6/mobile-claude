# Task 12 Report — Files tab + Settings + slash commands

**Status:** DONE  
**Date:** 2026-07-23  
**Commit:** `4617fbe` — `feat(mobile): files browser, settings, slash commands`

---

## Summary

Mobile client now has a real workspace file browser, settings screen, and chat slash-command routing:

- **FilesScreen**: `fs.list` tree (`.` root + subdirs), tap file → `fs.read` text preview; binary →「二进制文件」
- **SettingsScreen**: connection / workspace / model from `auth.ok` + `config.get`; auto-allow reads toggle → `config.set`; disconnect clears SecureStore and resets to Pair
- **ChatScreen**: messages matching `^/(model|clear)(\s|$)` send `slash.run` instead of `chat.send`

Chinese UI throughout.

---

## What was created / modified

| File | Purpose |
|---|---|
| `apps/mobile/src/screens/FilesScreen.tsx` | Directory listing + breadcrumb + file preview modal |
| `apps/mobile/src/screens/SettingsScreen.tsx` | Connection, workspace, auto-allow reads, disconnect |
| `apps/mobile/src/screens/ChatScreen.tsx` | Slash command parse + `slash.run` |

### FilesScreen behavior

1. Focus / pull-to-refresh → `fs.list` with path `.` or current relative path.
2. Tap directory → navigate in; 「‹ 上级」goes to parent.
3. Tap file → `fs.read` (`maxBytes` 256KB) modal preview.
4. Client-side binary heuristic (NUL / high control-char ratio) → show **二进制文件**.
5. Truncated previews show tip.

### SettingsScreen behavior

1. Focus → `config.get` → model, workspaceRoot, autoAllowReadTools, serverVersion, hasApiKey.
2. Workspace path also falls back to `auth.workspaceRoot`.
3. Switch toggles `config.set` `{ autoAllowReadTools }` (optimistic + rollback on error).
4. **断开连接并清除配对** → confirm → `disconnectAndForget` (SecureStore clear) → root reset to Pair.

### Slash commands

| Input | Action |
|---|---|
| `/clear` | `slash.run` `{ command: 'clear' }`; clear local timeline optimistically; server sends empty `session.snapshot` |
| `/model <name>` | `slash.run` `{ command: 'model', args }`; local system note + optimistic model label; server `status` + snapshot |
| Other text | `chat.send` as before |

Regex: `^/(model|clear)(\s|$)` — so `/models` is **not** treated as slash.

### Out of scope

- Manual E2E against live daemon (file tree + `/clear` + `/model`) — needs paired device/session
- Settings model picker UI (use chat `/model` or host default via config)
- Binary detection on server side

---

## Verification

```text
pnpm --filter mobile-claude typecheck
> tsc --noEmit
exit 0
```

Manual E2E not run in this agent environment (no interactive device / live pairing session).

---

## Notes

- Response types used: `fs.list_result`, `fs.read_result`, `config` (for get/set).
- Disconnect uses `navigation.getParent().reset({ routes: [{ name: 'Pair' }] })` because Pair lives on the root stack.
- API key is never accepted over WS; Settings only shows `hasApiKey` boolean from host.
