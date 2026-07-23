import crypto from 'node:crypto'
import type { AppDatabase } from './db.js'

export type SessionRow = {
  id: string
  title: string
  model: string
  created_at: number
  updated_at: number
}

export type MessageRow = {
  id: string
  session_id: string
  role: string
  content: unknown
  sort_index: number
  created_at: number
}

export type PermissionRuleRow = {
  id: string
  session_id: string
  tool: string
  pattern: string
  created_at: number
}

export type ToolRunRow = {
  id: string
  session_id: string
  message_id: string | null
  name: string
  input: unknown
  output: unknown
  status: string
  created_at: number
}

export type AppendMessageInput = {
  role: string
  content: unknown
  id?: string
}

export type AppendToolRunInput = {
  id?: string
  messageId?: string | null
  name: string
  input: unknown
  output?: unknown
  status: string
}

export type UpdateToolRunInput = {
  messageId?: string | null
  output?: unknown
  status?: string
}

export type AuditLogRow = {
  id: string
  ts: number
  kind: string
  detail: unknown
}

/** Session + message + permission-rule CRUD on SQLite. */
export class SessionStore {
  constructor(
    private readonly db: AppDatabase,
    private readonly defaultModel: string,
  ) {}

  list(): SessionRow[] {
    return this.db.all<SessionRow>(
      'SELECT id, title, model, created_at, updated_at FROM sessions ORDER BY updated_at DESC',
    )
  }

  create(title?: string): SessionRow {
    const now = Date.now()
    const row: SessionRow = {
      id: crypto.randomUUID(),
      title: title?.trim() || 'New session',
      model: this.defaultModel,
      created_at: now,
      updated_at: now,
    }
    this.db.run(
      'INSERT INTO sessions (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [row.id, row.title, row.model, row.created_at, row.updated_at],
    )
    this.db.persist()
    return row
  }

  get(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>(
      'SELECT id, title, model, created_at, updated_at FROM sessions WHERE id = ?',
      [id],
    )
  }

  delete(id: string): boolean {
    const existing = this.get(id)
    if (!existing) return false
    this.db.run('DELETE FROM messages WHERE session_id = ?', [id])
    this.db.run('DELETE FROM tool_runs WHERE session_id = ?', [id])
    this.db.run('DELETE FROM permission_rules WHERE session_id = ?', [id])
    this.db.run('DELETE FROM sessions WHERE id = ?', [id])
    this.db.persist()
    return true
  }

  appendMessage(sessionId: string, msg: AppendMessageInput): MessageRow {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`session not found: ${sessionId}`)
    }

    const maxRow = this.db.get<{ m: number | null }>(
      'SELECT MAX(sort_index) AS m FROM messages WHERE session_id = ?',
      [sessionId],
    )
    const nextIndex =
      maxRow?.m === null || maxRow?.m === undefined ? 0 : Number(maxRow.m) + 1

    const now = Date.now()
    const row: MessageRow = {
      id: msg.id ?? crypto.randomUUID(),
      session_id: sessionId,
      role: msg.role,
      content: msg.content,
      sort_index: nextIndex,
      created_at: now,
    }

    this.db.run(
      'INSERT INTO messages (id, session_id, role, content_json, sort_index, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        row.id,
        row.session_id,
        row.role,
        JSON.stringify(row.content),
        row.sort_index,
        row.created_at,
      ],
    )
    this.db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [now, sessionId])
    this.db.persist()
    return row
  }

  listMessages(sessionId: string): MessageRow[] {
    const rows = this.db.all<{
      id: string
      session_id: string
      role: string
      content_json: string
      sort_index: number
      created_at: number
    }>(
      'SELECT id, session_id, role, content_json, sort_index, created_at FROM messages WHERE session_id = ? ORDER BY sort_index ASC',
      [sessionId],
    )
    const result: MessageRow[] = []
    for (const r of rows) {
      let content: unknown
      try {
        content = JSON.parse(r.content_json) as unknown
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(
          `[sessionStore] skip message ${r.id}: invalid content_json (${msg})`,
        )
        continue
      }
      result.push({
        id: r.id,
        session_id: r.session_id,
        role: r.role,
        content,
        sort_index: r.sort_index,
        created_at: r.created_at,
      })
    }
    return result
  }

  setModel(sessionId: string, model: string): void {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`session not found: ${sessionId}`)
    }
    const now = Date.now()
    this.db.run('UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?', [
      model,
      now,
      sessionId,
    ])
    this.db.persist()
  }

  setTitle(sessionId: string, title: string): void {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`session not found: ${sessionId}`)
    }
    const now = Date.now()
    const t = title.trim() || 'New session'
    this.db.run('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', [
      t,
      now,
      sessionId,
    ])
    this.db.persist()
  }

  /**
   * Clear transcript for `/clear`. Keeps the same session id (and rules/model).
   */
  clearMessages(sessionId: string): void {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`session not found: ${sessionId}`)
    }
    this.db.run('DELETE FROM messages WHERE session_id = ?', [sessionId])
    this.db.run('DELETE FROM tool_runs WHERE session_id = ?', [sessionId])
    this.db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [
      Date.now(),
      sessionId,
    ])
    this.db.persist()
  }

  addPermissionRule(
    sessionId: string,
    tool: string,
    pattern: string,
  ): PermissionRuleRow {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`session not found: ${sessionId}`)
    }
    const existing = this.findPermissionRule(sessionId, tool, pattern)
    if (existing) return existing

    const row: PermissionRuleRow = {
      id: crypto.randomUUID(),
      session_id: sessionId,
      tool,
      pattern,
      created_at: Date.now(),
    }
    this.db.run(
      'INSERT INTO permission_rules (id, session_id, tool, pattern, created_at) VALUES (?, ?, ?, ?, ?)',
      [row.id, row.session_id, row.tool, row.pattern, row.created_at],
    )
    this.db.persist()
    return row
  }

  listPermissionRules(sessionId: string): PermissionRuleRow[] {
    return this.db.all<PermissionRuleRow>(
      'SELECT id, session_id, tool, pattern, created_at FROM permission_rules WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId],
    )
  }

  findPermissionRule(
    sessionId: string,
    tool: string,
    pattern: string,
  ): PermissionRuleRow | undefined {
    return this.db.get<PermissionRuleRow>(
      'SELECT id, session_id, tool, pattern, created_at FROM permission_rules WHERE session_id = ? AND tool = ? AND pattern = ?',
      [sessionId, tool, pattern],
    )
  }

  deletePermissionRule(id: string): boolean {
    const row = this.db.get<{ id: string }>(
      'SELECT id FROM permission_rules WHERE id = ?',
      [id],
    )
    if (!row) return false
    this.db.run('DELETE FROM permission_rules WHERE id = ?', [id])
    this.db.persist()
    return true
  }

  clearPermissionRules(sessionId: string): void {
    this.db.run('DELETE FROM permission_rules WHERE session_id = ?', [sessionId])
    this.db.persist()
  }

  appendToolRun(sessionId: string, run: AppendToolRunInput): ToolRunRow {
    const session = this.get(sessionId)
    if (!session) {
      throw new Error(`session not found: ${sessionId}`)
    }

    const row: ToolRunRow = {
      id: run.id ?? crypto.randomUUID(),
      session_id: sessionId,
      message_id: run.messageId ?? null,
      name: run.name,
      input: run.input,
      output: run.output ?? null,
      status: run.status,
      created_at: Date.now(),
    }

    this.db.run(
      'INSERT INTO tool_runs (id, session_id, message_id, name, input_json, output_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        row.id,
        row.session_id,
        row.message_id,
        row.name,
        JSON.stringify(row.input ?? null),
        row.output === null || row.output === undefined
          ? null
          : JSON.stringify(row.output),
        row.status,
        row.created_at,
      ],
    )
    this.db.persist()
    return row
  }

  updateToolRun(id: string, patch: UpdateToolRunInput): ToolRunRow {
    const existing = this.getToolRun(id)
    if (!existing) {
      throw new Error(`tool run not found: ${id}`)
    }

    const next: ToolRunRow = {
      ...existing,
      message_id:
        patch.messageId !== undefined ? patch.messageId : existing.message_id,
      output: patch.output !== undefined ? patch.output : existing.output,
      status: patch.status !== undefined ? patch.status : existing.status,
    }

    this.db.run(
      'UPDATE tool_runs SET message_id = ?, output_json = ?, status = ? WHERE id = ?',
      [
        next.message_id,
        next.output === null || next.output === undefined
          ? null
          : JSON.stringify(next.output),
        next.status,
        id,
      ],
    )
    this.db.persist()
    return next
  }

  getToolRun(id: string): ToolRunRow | undefined {
    const r = this.db.get<{
      id: string
      session_id: string
      message_id: string | null
      name: string
      input_json: string
      output_json: string | null
      status: string
      created_at: number
    }>(
      'SELECT id, session_id, message_id, name, input_json, output_json, status, created_at FROM tool_runs WHERE id = ?',
      [id],
    )
    if (!r) return undefined
    return parseToolRunRow(r)
  }

  listToolRuns(sessionId: string): ToolRunRow[] {
    const rows = this.db.all<{
      id: string
      session_id: string
      message_id: string | null
      name: string
      input_json: string
      output_json: string | null
      status: string
      created_at: number
    }>(
      'SELECT id, session_id, message_id, name, input_json, output_json, status, created_at FROM tool_runs WHERE session_id = ? ORDER BY created_at ASC',
      [sessionId],
    )
    return rows.map(parseToolRunRow)
  }

  listToolRunsForMessage(messageId: string): ToolRunRow[] {
    const rows = this.db.all<{
      id: string
      session_id: string
      message_id: string | null
      name: string
      input_json: string
      output_json: string | null
      status: string
      created_at: number
    }>(
      'SELECT id, session_id, message_id, name, input_json, output_json, status, created_at FROM tool_runs WHERE message_id = ? ORDER BY created_at ASC',
      [messageId],
    )
    return rows.map(parseToolRunRow)
  }

  /**
   * Append-only audit event (permission decisions, optional tool events).
   * Never stores secrets — callers must sanitize `detail`.
   */
  appendAudit(kind: string, detail: unknown): AuditLogRow {
    const row: AuditLogRow = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      kind,
      detail,
    }
    this.db.run(
      'INSERT INTO audit_log (id, ts, kind, detail_json) VALUES (?, ?, ?, ?)',
      [row.id, row.ts, row.kind, JSON.stringify(row.detail ?? null)],
    )
    this.db.persist()
    return row
  }

  listAudit(limit = 100, kind?: string): AuditLogRow[] {
    const capped = Math.max(1, Math.min(10_000, Math.floor(limit)))
    const rows = kind
      ? this.db.all<{
          id: string
          ts: number
          kind: string
          detail_json: string
        }>(
          'SELECT id, ts, kind, detail_json FROM audit_log WHERE kind = ? ORDER BY ts DESC LIMIT ?',
          [kind, capped],
        )
      : this.db.all<{
          id: string
          ts: number
          kind: string
          detail_json: string
        }>(
          'SELECT id, ts, kind, detail_json FROM audit_log ORDER BY ts DESC LIMIT ?',
          [capped],
        )

    return rows.map((r) => {
      let detail: unknown = null
      try {
        detail = JSON.parse(r.detail_json) as unknown
      } catch {
        detail = r.detail_json
      }
      return { id: r.id, ts: r.ts, kind: r.kind, detail }
    })
  }
}

function parseToolRunRow(r: {
  id: string
  session_id: string
  message_id: string | null
  name: string
  input_json: string
  output_json: string | null
  status: string
  created_at: number
}): ToolRunRow {
  let input: unknown = null
  let output: unknown = null
  try {
    input = JSON.parse(r.input_json) as unknown
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[sessionStore] tool_run ${r.id}: invalid input_json (${msg})`)
  }
  if (r.output_json != null) {
    try {
      output = JSON.parse(r.output_json) as unknown
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `[sessionStore] tool_run ${r.id}: invalid output_json (${msg})`,
      )
      output = r.output_json
    }
  }
  return {
    id: r.id,
    session_id: r.session_id,
    message_id: r.message_id,
    name: r.name,
    input,
    output,
    status: r.status,
    created_at: r.created_at,
  }
}
