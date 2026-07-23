#!/usr/bin/env node
/**
 * CLI entry: `mobile-claude-agent start --workspace <path> --port 7820 --host 127.0.0.1`
 */

import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, type AgentConfig } from './config.js'
import { startServer } from './server.js'

type StartFlags = {
  workspace?: string
  port?: number
  host?: string
  dataDir?: string
  help?: boolean
}

function printHelp(): void {
  console.log(`mobile-claude-agent — local coding agent daemon

Usage:
  mobile-claude-agent start [options]

Options:
  --workspace <path>   Workspace root (default: cwd or config)
  --port <number>      Listen port (default: 7820)
  --host <addr>        Bind address (default: 127.0.0.1)
  --data-dir <path>    Data directory for SQLite (default: ~/.mobile-claude)
  -h, --help           Show help

Environment:
  ANTHROPIC_API_KEY    Required for chat (never accepted over WebSocket)
  HOST, PORT, WORKSPACE_ROOT, DATA_DIR, DEFAULT_MODEL, ...

Examples:
  mobile-claude-agent start --workspace . --port 7820
  node dist/cli.js start --workspace C:\\\\code\\\\myapp --host 127.0.0.1
`)
}

function parseArgs(argv: string[]): { command: string | null; flags: StartFlags } {
  const args = argv.slice(2)
  if (args.length === 0) {
    return { command: null, flags: { help: true } }
  }

  const command = args[0] ?? null
  const flags: StartFlags = {}

  for (let i = 1; i < args.length; i++) {
    const a = args[i]!
    if (a === '-h' || a === '--help') {
      flags.help = true
      continue
    }
    if (a === '--workspace') {
      flags.workspace = args[++i]
      continue
    }
    if (a === '--port') {
      const raw = args[++i]
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`invalid --port: ${raw}`)
      }
      flags.port = n
      continue
    }
    if (a === '--host') {
      flags.host = args[++i]
      continue
    }
    if (a === '--data-dir') {
      flags.dataDir = args[++i]
      continue
    }
    if (a.startsWith('-')) {
      throw new Error(`unknown option: ${a}`)
    }
    throw new Error(`unexpected argument: ${a}`)
  }

  return { command, flags }
}

function applyFlags(base: AgentConfig, flags: StartFlags): AgentConfig {
  const workspaceRoot = flags.workspace
    ? path.resolve(flags.workspace)
    : base.workspaceRoot

  return {
    ...base,
    workspaceRoot,
    host: flags.host ?? base.host,
    port: flags.port ?? base.port,
    dataDir: flags.dataDir ? path.resolve(flags.dataDir) : base.dataDir,
  }
}

async function runStart(flags: StartFlags): Promise<void> {
  if (flags.help) {
    printHelp()
    return
  }

  const base = loadConfig()
  const config = applyFlags(base, flags)

  if (!fs.existsSync(config.workspaceRoot)) {
    throw new Error(`workspace does not exist: ${config.workspaceRoot}`)
  }
  const st = fs.statSync(config.workspaceRoot)
  if (!st.isDirectory()) {
    throw new Error(`workspace is not a directory: ${config.workspaceRoot}`)
  }

  // Resolve to real path for sandbox
  config.workspaceRoot = fs.realpathSync(config.workspaceRoot)

  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY)
  if (!hasKey) {
    console.warn(
      '[warn] ANTHROPIC_API_KEY is not set — chat.send will fail until it is configured on the host.',
    )
  }

  const server = await startServer(config)

  console.log('')
  console.log('  Mobile Claude Agent')
  console.log('  ───────────────────')
  console.log(`  listening   ws://${server.host}:${server.port}`)
  console.log(`  workspace   ${config.workspaceRoot}`)
  console.log(`  dataDir     ${config.dataDir}`)
  console.log(`  pairing     ${server.pairingCode}`)
  console.log('')
  console.log('  Enter the pairing code in the mobile app (valid ~10 min).')
  console.log('  Press Ctrl+C to stop.')
  console.log('')

  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] ${signal}`)
    try {
      await server.close()
    } catch (err) {
      console.error('[shutdown] error:', err instanceof Error ? err.message : err)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

async function main(): Promise<void> {
  let parsed: { command: string | null; flags: StartFlags }
  try {
    parsed = parseArgs(process.argv)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    printHelp()
    process.exit(1)
    return
  }

  if (parsed.flags.help || !parsed.command) {
    printHelp()
    process.exit(parsed.command ? 0 : 1)
    return
  }

  if (parsed.command !== 'start') {
    console.error(`unknown command: ${parsed.command}`)
    printHelp()
    process.exit(1)
    return
  }

  try {
    await runStart(parsed.flags)
  } catch (err) {
    console.error('[fatal]', err instanceof Error ? err.message : err)
    process.exit(1)
  }
}

void main()
