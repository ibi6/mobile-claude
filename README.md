# Mobile Claude Code

Phone remote console + self-hosted Agent daemon for coding agents.

## Monorepo

| Package | Description |
|---|---|
| `@mobile-claude/protocol` | Shared WebSocket envelope, Zod schemas, message types |
| `@mobile-claude/agent` | Agent daemon (Node.js) — *not yet* |
| `apps/mobile` | Expo React Native client — *not yet* |

## Requirements

- Node.js 20+
- pnpm 9+

## Agent persistence note

`@mobile-claude/agent` stores sessions/devices in SQLite under `~/.mobile-claude/data.db` (override via config/`DATA_DIR`).

Native `better-sqlite3` failed to compile on Windows without the ClangCL VS toolset, so the daemon uses **sql.js** (WASM) with file export/persist instead. API surface is the same for consumers (`openDb` is async).

## Scripts

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## Protocol

Wire protocol version `v: 1`. Shared types live in `packages/protocol`.

## License

Private / WIP.
