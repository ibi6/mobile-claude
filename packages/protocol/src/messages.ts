import { z } from 'zod'

// ── Shared enums / primitives ───────────────────────────────────────────────

export const PermissionDecisionSchema = z.enum(['allow_once', 'allow_session', 'deny'])
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>

export const RiskLevelSchema = z.enum(['low', 'medium', 'high'])
export type RiskLevel = z.infer<typeof RiskLevelSchema>

export const SessionPhaseSchema = z.enum(['idle', 'thinking', 'tool', 'awaiting_permission'])
export type SessionPhase = z.infer<typeof SessionPhaseSchema>

export const SlashCommandSchema = z.enum(['model', 'clear'])
export type SlashCommand = z.infer<typeof SlashCommandSchema>

export const ErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'validation',
  'busy',
  'aborted',
  'upstream',
  'tool_failed',
  'internal',
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

// ── Client → Server ─────────────────────────────────────────────────────────

export const AuthPairPayloadSchema = z.object({
  code: z.string().min(1),
  deviceName: z.string().min(1),
})
export type AuthPairPayload = z.infer<typeof AuthPairPayloadSchema>

export const AuthHelloPayloadSchema = z.object({
  deviceToken: z.string().min(1),
  clientVersion: z.string().min(1),
})
export type AuthHelloPayload = z.infer<typeof AuthHelloPayloadSchema>

export const SessionListPayloadSchema = z.object({}).strict()
export type SessionListPayload = z.infer<typeof SessionListPayloadSchema>

export const SessionCreatePayloadSchema = z.object({
  title: z.string().optional(),
})
export type SessionCreatePayload = z.infer<typeof SessionCreatePayloadSchema>

export const SessionOpenPayloadSchema = z.object({
  sessionId: z.string().min(1),
})
export type SessionOpenPayload = z.infer<typeof SessionOpenPayloadSchema>

export const SessionDeletePayloadSchema = z.object({
  sessionId: z.string().min(1),
})
export type SessionDeletePayload = z.infer<typeof SessionDeletePayloadSchema>

export const ChatSendPayloadSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
})
export type ChatSendPayload = z.infer<typeof ChatSendPayloadSchema>

export const ChatAbortPayloadSchema = z.object({
  sessionId: z.string().min(1),
})
export type ChatAbortPayload = z.infer<typeof ChatAbortPayloadSchema>

export const SlashRunPayloadSchema = z.object({
  sessionId: z.string().min(1),
  command: SlashCommandSchema,
  args: z.string().optional(),
})
export type SlashRunPayload = z.infer<typeof SlashRunPayloadSchema>

export const PermissionRespondPayloadSchema = z.object({
  requestId: z.string().min(1),
  decision: PermissionDecisionSchema,
})
export type PermissionRespondPayload = z.infer<typeof PermissionRespondPayloadSchema>

export const FsListPayloadSchema = z.object({
  path: z.string(),
})
export type FsListPayload = z.infer<typeof FsListPayloadSchema>

export const FsReadPayloadSchema = z.object({
  path: z.string(),
  maxBytes: z.number().int().positive().optional(),
})
export type FsReadPayload = z.infer<typeof FsReadPayloadSchema>

export const ConfigGetPayloadSchema = z.object({}).strict()
export type ConfigGetPayload = z.infer<typeof ConfigGetPayloadSchema>

/** Never accepts API key over WS in v1. */
export const ConfigSetPayloadSchema = z.object({
  model: z.string().min(1).optional(),
  autoAllowReadTools: z.boolean().optional(),
})
export type ConfigSetPayload = z.infer<typeof ConfigSetPayloadSchema>

// ── Server → Client ─────────────────────────────────────────────────────────

export const AuthOkPayloadSchema = z.object({
  deviceId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  serverVersion: z.string().min(1),
})
export type AuthOkPayload = z.infer<typeof AuthOkPayloadSchema>

/** Pairing response may also return a one-time deviceToken (shown once). */
export const AuthPairResultPayloadSchema = z.object({
  deviceToken: z.string().min(1),
  deviceId: z.string().min(1),
})
export type AuthPairResultPayload = z.infer<typeof AuthPairResultPayloadSchema>

export const SessionSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  model: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type SessionSummary = z.infer<typeof SessionSummarySchema>

export const SessionListResultPayloadSchema = z.object({
  sessions: z.array(SessionSummarySchema),
})
export type SessionListResultPayload = z.infer<typeof SessionListResultPayloadSchema>

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  role: MessageRoleSchema,
  content: z.unknown(),
  createdAt: z.number().int().nonnegative().optional(),
})
export type ChatMessage = z.infer<typeof ChatMessageSchema>

export const PermissionRequestPayloadSchema = z.object({
  requestId: z.string().min(1),
  toolRunId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
  risk: RiskLevelSchema,
})
export type PermissionRequestPayload = z.infer<typeof PermissionRequestPayloadSchema>

export const StatusPayloadSchema = z.object({
  phase: SessionPhaseSchema,
  model: z.string(),
  busy: z.boolean(),
})
export type StatusPayload = z.infer<typeof StatusPayloadSchema>

export const SessionSnapshotPayloadSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string(),
  messages: z.array(ChatMessageSchema),
  pendingPermission: PermissionRequestPayloadSchema.nullable().optional(),
  status: StatusPayloadSchema,
})
export type SessionSnapshotPayload = z.infer<typeof SessionSnapshotPayloadSchema>

export const MessageDeltaPayloadSchema = z.object({
  messageId: z.string().min(1),
  role: z.literal('assistant'),
  text: z.string(),
})
export type MessageDeltaPayload = z.infer<typeof MessageDeltaPayloadSchema>

export const MessageCompletedPayloadSchema = z.object({
  messageId: z.string().min(1),
  stopReason: z.string(),
})
export type MessageCompletedPayload = z.infer<typeof MessageCompletedPayloadSchema>

export const ToolStartedPayloadSchema = z.object({
  toolRunId: z.string().min(1),
  name: z.string().min(1),
  inputSummary: z.string(),
  input: z.unknown(),
})
export type ToolStartedPayload = z.infer<typeof ToolStartedPayloadSchema>

export const ToolProgressPayloadSchema = z.object({
  toolRunId: z.string().min(1),
  text: z.string().optional(),
})
export type ToolProgressPayload = z.infer<typeof ToolProgressPayloadSchema>

export const ToolCompletedPayloadSchema = z.object({
  toolRunId: z.string().min(1),
  status: z.string().min(1),
  outputSummary: z.string(),
  output: z.unknown().optional(),
})
export type ToolCompletedPayload = z.infer<typeof ToolCompletedPayloadSchema>

export const DiffAvailablePayloadSchema = z.object({
  toolRunId: z.string().min(1),
  path: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  unifiedDiff: z.string(),
})
export type DiffAvailablePayload = z.infer<typeof DiffAvailablePayloadSchema>

export const ErrorPayloadSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
  replyTo: z.string().optional(),
})
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>

// ── Message type constants (optional catalog helpers) ───────────────────────

export const ClientMessageTypes = [
  'auth.pair',
  'auth.hello',
  'session.list',
  'session.create',
  'session.open',
  'session.delete',
  'chat.send',
  'chat.abort',
  'slash.run',
  'permission.respond',
  'fs.list',
  'fs.read',
  'config.get',
  'config.set',
] as const

export const ServerMessageTypes = [
  'auth.ok',
  'auth.pair_result',
  'session.list_result',
  'session.snapshot',
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'permission.request',
  'diff.available',
  'status',
  'error',
] as const

export type ClientMessageType = (typeof ClientMessageTypes)[number]
export type ServerMessageType = (typeof ServerMessageTypes)[number]
