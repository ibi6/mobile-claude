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
