/**
 * @mobile-claude/agent public API
 */

export { loadConfig, type AgentConfig, type LoadConfigOptions } from './config.js'
export { openDb, type AppDatabase } from './db.js'
export { AuthService, type PairResult, type PairingCodeResult } from './auth.js'
export { SessionStore, type SessionRow, type MessageRow } from './sessionStore.js'
export {
  resolvePermission,
  patternForTool,
  riskForTool,
  type UserDecision,
  type RiskLevel,
} from './permissions.js'
export {
  assertInsideWorkspace,
  toRelative,
  PathEscapeError,
} from './paths.js'
export {
  listWorkspaceDir,
  readWorkspaceFile,
  type FsListEntry,
  type FsListResult,
  type FsReadResult,
} from './fsApi.js'
export {
  startServer,
  type StartServerResult,
  type StartServerOptions,
} from './server.js'
export {
  runAgentLoop,
  buildAnthropicMessages,
  type LoopEvents,
  type RunAgentLoopArgs,
} from './anthropic/loop.js'
export {
  createAnthropicClient,
  type StreamMessageFn,
} from './anthropic/client.js'
