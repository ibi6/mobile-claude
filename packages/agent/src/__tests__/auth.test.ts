import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { openDb, type AppDatabase } from '../db'
import { AuthService } from '../auth'

describe('AuthService', () => {
  let dataDir: string
  let db: AppDatabase
  let auth: AuthService

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-auth-'))
    db = await openDb(dataDir)
    auth = new AuthService(db, { pairingCodeTtlMs: 600_000 })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('hashToken returns sha256 hex of token', () => {
    const token = 'abc'
    const expected = crypto.createHash('sha256').update(token).digest('hex')
    expect(auth.hashToken(token)).toBe(expected)
  })

  it('createPairingCode then pair returns deviceToken once and verifies', () => {
    const { code, expiresAt } = auth.createPairingCode()
    expect(code).toMatch(/^[A-Z0-9]{6}$/)
    expect(expiresAt).toBeGreaterThan(Date.now())

    const result = auth.pair(code, 'Pixel 8')
    expect(result.deviceId).toBeTruthy()
    expect(result.deviceToken).toBeTruthy()
    // base64url, 32 bytes → ~43 chars
    expect(result.deviceToken).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(result.deviceToken.length).toBeGreaterThanOrEqual(40)

    expect(auth.verifyToken(result.deviceToken)).toBe(result.deviceId)
    expect(auth.verifyToken('not-a-real-token')).toBeNull()
  })

  it('pairing code is single-use', () => {
    const { code } = auth.createPairingCode()
    auth.pair(code, 'Device A')
    expect(() => auth.pair(code, 'Device B')).toThrow(/invalid|expired|pairing/i)
  })

  it('rejects expired pairing code', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const shortTtl = new AuthService(db, { pairingCodeTtlMs: 1000 })
    const { code } = shortTtl.createPairingCode()

    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'))
    expect(() => shortTtl.pair(code, 'Late')).toThrow(/invalid|expired|pairing/i)
  })

  it('rejects unknown pairing code', () => {
    expect(() => auth.pair('ZZZZZZ', 'Nope')).toThrow(/invalid|expired|pairing/i)
  })

  it('stores only token hash, not raw token', () => {
    const { code } = auth.createPairingCode()
    const { deviceToken } = auth.pair(code, 'Sec')
    const rows = db.all<{ token_hash: string; name: string }>('SELECT token_hash, name FROM devices')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('Sec')
    expect(rows[0]!.token_hash).toBe(auth.hashToken(deviceToken))
    expect(rows[0]!.token_hash).not.toBe(deviceToken)
  })
})
