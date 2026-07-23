import crypto from 'node:crypto'
import type { AppDatabase } from './db.js'

export type PairingCodeResult = {
  code: string
  expiresAt: number
}

export type PairResult = {
  deviceToken: string
  deviceId: string
}

export type AuthServiceOptions = {
  pairingCodeTtlMs: number
}

/** Pairing / device-token auth against the SQLite store. */
export class AuthService {
  constructor(
    private readonly db: AppDatabase,
    private readonly opts: AuthServiceOptions,
  ) {}

  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
  }

  /**
   * Create a single-use pairing code (6 uppercase alphanumeric).
   * Any previous unused codes remain until expiry; pair deletes on success.
   */
  createPairingCode(): PairingCodeResult {
    const code = generatePairingCode()
    const expiresAt = Date.now() + this.opts.pairingCodeTtlMs
    this.db.run('INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)', [
      code,
      expiresAt,
    ])
    this.db.persist()
    return { code, expiresAt }
  }

  /**
   * Validate pairing code, consume it, issue device token (raw returned once).
   * Stores only sha256(token).
   */
  pair(code: string, deviceName: string): PairResult {
    const name = deviceName.trim()
    if (!name) {
      throw new Error('device name is required')
    }

    const normalized = code.trim().toUpperCase()
    const row = this.db.get<{ code: string; expires_at: number }>(
      'SELECT code, expires_at FROM pairing_codes WHERE code = ?',
      [normalized],
    )

    if (!row) {
      throw new Error('invalid or expired pairing code')
    }
    if (row.expires_at < Date.now()) {
      this.db.run('DELETE FROM pairing_codes WHERE code = ?', [normalized])
      this.db.persist()
      throw new Error('invalid or expired pairing code')
    }

    // Insert device first, then consume code — never orphan a used code on insert failure.
    // Wrapped in a transaction so both succeed or neither does.
    const deviceId = crypto.randomUUID()
    const deviceToken = crypto.randomBytes(32).toString('base64url')
    const tokenHash = this.hashToken(deviceToken)
    const createdAt = Date.now()

    try {
      this.db.exec('BEGIN')
      this.db.run(
        'INSERT INTO devices (id, token_hash, name, created_at) VALUES (?, ?, ?, ?)',
        [deviceId, tokenHash, name, createdAt],
      )
      this.db.run('DELETE FROM pairing_codes WHERE code = ?', [normalized])
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* ignore rollback errors */
      }
      throw err
    }
    this.db.persist()

    return { deviceToken, deviceId }
  }

  /** Return deviceId if token is known; otherwise null. */
  verifyToken(token: string): string | null {
    if (!token) return null
    const hash = this.hashToken(token)
    const row = this.db.get<{ id: string }>(
      'SELECT id FROM devices WHERE token_hash = ?',
      [hash],
    )
    return row?.id ?? null
  }
}

/** 6-char uppercase A-Z0-9 (excluding ambiguous I,O,0,1). */
function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.randomBytes(6)
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += alphabet[bytes[i]! % alphabet.length]
  }
  return code
}
