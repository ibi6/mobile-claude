# Mobile Claude Code

Phone remote console + self-hosted Agent daemon for coding agents.

## Monorepo

| Package | Description |
|---|---|
| `@mobile-claude/protocol` | Shared WebSocket envelope, Zod schemas, message types |
| `@mobile-claude/agent` | Agent daemon (Node.js WebSocket server + CLI) |
| `apps/mobile` | Expo React Native client — *not yet* |

## Requirements

- Node.js 20+
- pnpm 9+
- Anthropic API key on the **host** only (`ANTHROPIC_API_KEY`) — never sent over WebSocket

## Run the agent daemon

```bash
pnpm install
pnpm --filter @mobile-claude/protocol build
pnpm --filter @mobile-claude/agent build

# From repo root (or any workspace path):
export ANTHROPIC_API_KEY=sk-ant-...   # host env only
pnpm --filter @mobile-claude/agent start -- --workspace . --port 7820 --host 127.0.0.1

# Or via package bin after build/link:
# mobile-claude-agent start --workspace /path/to/project --port 7820
# node packages/agent/dist/cli.js start --workspace . --port 7820
```

On start the daemon prints a **pairing code** (6 characters). Enter it in the mobile app once; the app receives a device token for later `auth.hello` reconnects.

| Flag | Default | Meaning |
|---|---|---|
| `--workspace` | cwd / config | Sandboxed project root |
| `--port` | `7820` | Listen port |
| `--host` | `127.0.0.1` | Bind address (default loopback only) |
| `--data-dir` | `~/.mobile-claude` | SQLite + state |

Config file (optional): `~/.mobile-claude/config.json` — see `loadConfig` (`HOST`, `PORT`, `WORKSPACE_ROOT`, `DATA_DIR`, `DEFAULT_MODEL`, `AUTO_ALLOW_READ_TOOLS`, …).

**Security notes**

- Default bind is `127.0.0.1` (not LAN). Exposing beyond localhost requires your own tunnel/VPN and threat model.
- API keys are **never** accepted via WebSocket `config.set` / payloads — set `ANTHROPIC_API_KEY` on the host process only.
- Pairing codes are single-use and expire (default 10 minutes).

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
