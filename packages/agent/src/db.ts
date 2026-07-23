import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'
import type { Database as SqlJsDatabase, SqlJsStatic, SqlValue } from 'sql.js'

export type { SqlValue }

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  sort_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS tool_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS permission_rules (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  pattern TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_sort
  ON messages(session_id, sort_index);
CREATE INDEX IF NOT EXISTS idx_permission_rules_lookup
  ON permission_rules(session_id, tool, pattern);
CREATE INDEX IF NOT EXISTS idx_sessions_updated
  ON sessions(updated_at DESC);
`

export type AppDatabase = {
  readonly dbPath: string
  exec(sql: string): void
  run(sql: string, params?: SqlValue[]): void
  get<T extends Record<string, unknown>>(sql: string, params?: SqlValue[]): T | undefined
  all<T extends Record<string, unknown>>(sql: string, params?: SqlValue[]): T[]
  persist(): void
  close(): void
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('sql.js')
    const distDir = path.dirname(entry)
    sqlJsPromise = initSqlJs({
      locateFile: (file) => path.join(distDir, file),
    })
  }
  return sqlJsPromise
}

function rowsFromStatement(
  stmt: ReturnType<SqlJsDatabase['prepare']>,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject() as Record<string, unknown>)
  }
  stmt.free()
  return rows
}

/**
 * Open (or create) `dataDir/data.db` with schema applied.
 *
 * Uses **sql.js** (WASM) with explicit file persist — native better-sqlite3
 * failed to build on this Windows host (ClangCL toolset missing).
 */
export async function openDb(dataDir: string): Promise<AppDatabase> {
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'data.db')
  const SQL = await loadSqlJs()

  let raw: SqlJsDatabase
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath)
    raw = new SQL.Database(new Uint8Array(buf))
  } else {
    raw = new SQL.Database()
  }

  raw.exec(SCHEMA_SQL)

  let closed = false

  const api: AppDatabase = {
    dbPath,
    exec(sql: string) {
      raw.exec(sql)
    },
    run(sql: string, params: SqlValue[] = []) {
      raw.run(sql, params)
    },
    get<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | undefined {
      const stmt = raw.prepare(sql)
      if (params.length > 0) stmt.bind(params)
      const rows = rowsFromStatement(stmt)
      return rows[0] as T | undefined
    },
    all<T extends Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] {
      const stmt = raw.prepare(sql)
      if (params.length > 0) stmt.bind(params)
      return rowsFromStatement(stmt) as T[]
    },
    persist() {
      if (closed) return
      const data = raw.export()
      fs.writeFileSync(dbPath, Buffer.from(data))
    },
    close() {
      if (closed) return
      api.persist()
      raw.close()
      closed = true
    },
  }

  // Ensure empty DB is written on first open
  api.persist()
  return api
}
