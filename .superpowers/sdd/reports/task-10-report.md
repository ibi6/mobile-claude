# Task 10 Report — Chat UI + streaming + tool cards + abort

**Status:** DONE  
**Date:** 2026-07-23  
**Commit:** `feat(mobile): chat streaming and tool cards`

---

## Summary

Implemented Chinese chat UI over existing `ConnectionProvider` / `AgentClient` and navigation `Chat` route (`sessionId` param): focus opens `session.open` and applies `session.snapshot`; composer sends `chat.send`; live `message.delta` / `message.completed` stream into assistant bubbles; `tool.started` / `tool.progress` / `tool.completed` render `ToolCard`s in the timeline; stop sends `chat.abort`; header status chip driven by `status` events (紫靛蓝主题).

---

## What was created / modified

| File | Purpose |
|---|---|
| `apps/mobile/src/screens/ChatScreen.tsx` | Full chat screen: open / stream / tools / abort / status |
| `apps/mobile/src/components/MessageBubble.tsx` | User / assistant / system bubbles |
| `apps/mobile/src/components/ToolCard.tsx` | Tool run card (running → completed / denied / error) |

### Behavior

1. **Focus** (`useFocusEffect`): subscribe to protocol events filtered by `sessionId` → `session.open` → apply `session.snapshot` (title, messages, status).
2. **Composer**: optimistic user bubble → `chat.send` `{ sessionId, text }`. Disabled while `busy`.
3. **`message.delta`**: append text to assistant item by `messageId` (create if missing); streaming caret.
4. **`message.completed`**: clear streaming flag.
5. **`tool.started` / `tool.completed`**: insert/update `ToolCard` by `toolRunId` (optional `tool.progress` appends to output summary).
6. **Stop**: header meta bar + composer abort → `chat.abort`.
7. **`status`**: phase chip in nav header (`空闲` / `思考中` / `工具中` / `等待授权`) + model line.
8. **Errors**: banner with tap-to-retry open; pre-turn error codes clear optimistic busy.

### Out of scope (later tasks)

- Permission sheet / `permission.respond` → Task 11  
- Diff viewer on ToolCard → Task 11  
- `/model` `/clear` slash → Task 12  

---

## Verification

```text
pnpm --filter mobile-claude typecheck
> tsc --noEmit
exit 0
```

Manual E2E (“list files in workspace” with API key + paired device) not run in this agent environment (no interactive device / live daemon pairing session).

---

## Notes

- Snapshot messages only include user/assistant/system content; tool cards are live-event timeline items (not reconstructed from history).
- Optimistic user bubble uses a local id until next `session.open` reloads authoritative messages.
