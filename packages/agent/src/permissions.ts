/**
 * Permission gate: decide allow vs ask before tool execution.
 * Session rules are exact tool + pattern matches (v1: no prefix/fuzzy).
 */

export type PermissionDecision = 'allow' | 'ask'

/** User response from the mobile permission sheet. */
export type UserDecision = 'allow_once' | 'allow_session' | 'deny'

export type RiskLevel = 'low' | 'medium' | 'high'

export type PermissionRule = {
  tool: string
  pattern: string
}

export type ResolvePermissionArgs = {
  tool: string
  pattern: string
  /** Session id (caller filters rules; kept for API symmetry with store). */
  sessionId?: string
  autoAllowReadTools: boolean
  rules: PermissionRule[]
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])

const LOW_RISK = new Set(['Read', 'Glob', 'Grep'])
const MEDIUM_RISK = new Set(['Write', 'Edit'])

/**
 * Resolve whether a tool call may run without prompting.
 * Order: exact session rule → optional auto-allow for read tools → ask.
 * Bash is never auto-allowed via autoAllowReadTools.
 */
export function resolvePermission(args: ResolvePermissionArgs): PermissionDecision {
  if (args.rules.some((r) => r.tool === args.tool && r.pattern === args.pattern)) {
    return 'allow'
  }
  if (args.autoAllowReadTools && READ_TOOLS.has(args.tool)) {
    return 'allow'
  }
  return 'ask'
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return {}
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v : ''
}

/**
 * Build the rule-matching pattern for a tool call.
 * File tools → path; Glob → glob pattern; Grep → path or search pattern; Bash → exact command.
 */
export function patternForTool(tool: string, input: unknown): string {
  const obj = asRecord(input)

  if (tool === 'Bash') {
    return stringField(obj, 'command')
  }
  if (tool === 'Glob') {
    return stringField(obj, 'pattern')
  }
  if (tool === 'Grep') {
    const path = stringField(obj, 'path')
    if (path) return path
    return stringField(obj, 'pattern')
  }
  // Read, Write, Edit, and any path-based tool
  return stringField(obj, 'path')
}

/**
 * Risk level shown on the permission request sheet.
 * Read tools low; Write/Edit medium; Bash and unknown high.
 */
export function riskForTool(tool: string): RiskLevel {
  if (LOW_RISK.has(tool)) return 'low'
  if (MEDIUM_RISK.has(tool)) return 'medium'
  return 'high'
}
