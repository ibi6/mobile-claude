import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../config'

describe('loadConfig', () => {
  let tmpHome: string
  let configPath: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'))
    configPath = path.join(tmpHome, '.mobile-claude', 'config.json')
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('returns defaults when no config file and empty env overrides', () => {
    const cfg = loadConfig({
      env: {},
      homeDir: tmpHome,
      cwd: path.join(tmpHome, 'proj'),
    })
    expect(cfg.host).toBe('127.0.0.1')
    expect(cfg.port).toBe(7820)
    expect(cfg.workspaceRoot).toBe(path.join(tmpHome, 'proj'))
    expect(cfg.dataDir).toBe(path.join(tmpHome, '.mobile-claude'))
    expect(cfg.defaultModel).toBeTruthy()
    expect(cfg.autoAllowReadTools).toBe(true)
    expect(cfg.pairingCodeTtlMs).toBe(600_000)
    expect(['powershell', 'bash', 'cmd']).toContain(cfg.shell)
  })

  it('reads config.json and merges env overrides', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        host: '0.0.0.0',
        port: 9000,
        workspaceRoot: path.join(tmpHome, 'ws'),
        defaultModel: 'claude-test',
        shell: 'cmd',
        autoAllowReadTools: false,
      }),
    )

    const cfg = loadConfig({
      env: {
        PORT: '7821',
        DEFAULT_MODEL: 'from-env',
      },
      homeDir: tmpHome,
      cwd: tmpHome,
      configPath,
    })

    expect(cfg.host).toBe('0.0.0.0')
    expect(cfg.port).toBe(7821) // env wins
    expect(cfg.workspaceRoot).toBe(path.join(tmpHome, 'ws'))
    expect(cfg.defaultModel).toBe('from-env') // env wins
    expect(cfg.shell).toBe('cmd')
    expect(cfg.autoAllowReadTools).toBe(false)
  })
})
