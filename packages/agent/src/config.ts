import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type AgentConfig = {
  host: string
  port: number
  workspaceRoot: string
  dataDir: string
  defaultModel: string
  shell: 'powershell' | 'bash' | 'cmd'
  autoAllowReadTools: boolean
  pairingCodeTtlMs: number
}

export type LoadConfigOptions = {
  /** Override process.env (for tests) */
  env?: NodeJS.ProcessEnv
  /** Override os.homedir() */
  homeDir?: string
  /** Override process.cwd() */
  cwd?: string
  /** Explicit path to config.json */
  configPath?: string
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
const DEFAULT_PORT = 7820
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PAIRING_TTL_MS = 600_000

type FileConfig = Partial<{
  host: string
  port: number
  workspaceRoot: string
  dataDir: string
  defaultModel: string
  shell: string
  autoAllowReadTools: boolean
  pairingCodeTtlMs: number
}>

function defaultShell(platform: NodeJS.Platform): AgentConfig['shell'] {
  return platform === 'win32' ? 'powershell' : 'bash'
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const v = value.trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes') return true
  if (v === '0' || v === 'false' || v === 'no') return false
  return undefined
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid PORT: ${value}`)
  }
  return n
}

function parseShell(value: string | undefined): AgentConfig['shell'] | undefined {
  if (value === undefined || value === '') return undefined
  if (value === 'powershell' || value === 'bash' || value === 'cmd') return value
  throw new Error(`invalid shell: ${value} (expected powershell|bash|cmd)`)
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid positive integer: ${value}`)
  }
  return n
}

function readFileConfig(configPath: string): FileConfig {
  if (!fs.existsSync(configPath)) return {}
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config root must be an object')
    }
    return parsed as FileConfig
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to read config at ${configPath}: ${msg}`)
  }
}

/**
 * Load agent config from optional `config.json` + env overrides.
 *
 * Precedence (high → low): env → config file → built-in defaults.
 * Default paths: `~/.mobile-claude/config.json`, dataDir `~/.mobile-claude`.
 */
export function loadConfig(opts: LoadConfigOptions = {}): AgentConfig {
  const env = opts.env ?? process.env
  const homeDir = opts.homeDir ?? os.homedir()
  const cwd = opts.cwd ?? process.cwd()
  const configPath =
    opts.configPath ??
    env.MOBILE_CLAUDE_CONFIG ??
    path.join(homeDir, '.mobile-claude', 'config.json')

  const file = readFileConfig(configPath)

  const shell =
    parseShell(env.SHELL_KIND) ??
    parseShell(file.shell) ??
    defaultShell(process.platform)

  const autoAllowFromEnv = parseBool(env.AUTO_ALLOW_READ_TOOLS)

  return {
    host: env.HOST ?? file.host ?? DEFAULT_HOST,
    port: parsePort(env.PORT) ?? file.port ?? DEFAULT_PORT,
    workspaceRoot: env.WORKSPACE_ROOT ?? file.workspaceRoot ?? cwd,
    dataDir: env.DATA_DIR ?? file.dataDir ?? path.join(homeDir, '.mobile-claude'),
    defaultModel: env.DEFAULT_MODEL ?? file.defaultModel ?? DEFAULT_MODEL,
    shell,
    autoAllowReadTools: autoAllowFromEnv ?? file.autoAllowReadTools ?? true,
    pairingCodeTtlMs:
      parsePositiveInt(env.PAIRING_CODE_TTL_MS) ??
      file.pairingCodeTtlMs ??
      DEFAULT_PAIRING_TTL_MS,
  }
}
