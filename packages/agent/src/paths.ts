import fs from 'node:fs'
import path from 'node:path'

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathEscapeError'
  }
}

export function assertInsideWorkspace(workspaceRoot: string, userPath: string): string {
  const rootReal = fs.realpathSync(workspaceRoot)
  const candidate = path.isAbsolute(userPath)
    ? userPath
    : path.resolve(rootReal, userPath)
  // If file does not exist yet (Write), realpath parent
  let resolved: string
  try {
    resolved = fs.realpathSync(candidate)
  } catch {
    const parent = fs.realpathSync(path.dirname(candidate))
    resolved = path.join(parent, path.basename(candidate))
  }
  const rel = path.relative(rootReal, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PathEscapeError(`path escapes workspace: ${userPath}`)
  }
  return resolved
}

export function toRelative(workspaceRoot: string, absPath: string): string {
  const rootReal = fs.realpathSync(workspaceRoot)
  return path.relative(rootReal, absPath).split(path.sep).join('/')
}
