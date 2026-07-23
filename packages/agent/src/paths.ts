import fs from 'node:fs'
import path from 'node:path'

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathEscapeError'
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/**
 * True when `resolved` is outside `rootReal`.
 * Uses exact `..` / `..${sep}` checks so filenames like `..foo` are not false positives.
 */
function escapesWorkspace(rootReal: string, resolved: string): boolean {
  const rel = path.relative(rootReal, resolved)
  return rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
}

/**
 * realpathSync when the path exists; on ENOENT only, walk up ancestors until a
 * realpath-able directory is found, then join the remaining segments.
 * Non-ENOENT errors are rethrown.
 */
function resolveExistingOrAncestors(candidate: string): string {
  try {
    return fs.realpathSync(candidate)
  } catch (err) {
    if (!isEnoent(err)) throw err
  }

  const segments: string[] = []
  let current = candidate

  while (true) {
    const parent = path.dirname(current)
    if (parent === current) {
      // Filesystem root reached without a realpath-able ancestor
      const err = new Error(
        `ENOENT: no such file or directory, realpath '${candidate}'`,
      ) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }

    segments.unshift(path.basename(current))
    try {
      const parentReal = fs.realpathSync(parent)
      return path.join(parentReal, ...segments)
    } catch (err) {
      if (!isEnoent(err)) throw err
      current = parent
    }
  }
}

/**
 * Resolve `userPath` against `workspaceRoot` and ensure the result stays inside
 * the workspace sandbox. Returns the absolute resolved path.
 *
 * Non-existent paths (e.g. Write targets) are resolved by walking up to the
 * nearest existing ancestor directory, then joining remaining segments.
 * Only ENOENT is handled that way; other fs errors propagate.
 */
export function assertInsideWorkspace(workspaceRoot: string, userPath: string): string {
  const rootReal = fs.realpathSync(workspaceRoot)
  const candidate = path.isAbsolute(userPath)
    ? userPath
    : path.resolve(rootReal, userPath)

  const resolved = resolveExistingOrAncestors(candidate)

  if (escapesWorkspace(rootReal, resolved)) {
    throw new PathEscapeError(`path escapes workspace: ${userPath}`)
  }
  return resolved
}

/**
 * Convert an absolute path to a workspace-relative path using forward slashes.
 *
 * **Precondition:** `absPath` must already be inside the workspace (typically the
 * return value of {@link assertInsideWorkspace}). Both sides are realpath'd
 * (with ancestor walk on ENOENT). If the result escapes the workspace,
 * {@link PathEscapeError} is thrown.
 */
export function toRelative(workspaceRoot: string, absPath: string): string {
  const rootReal = fs.realpathSync(workspaceRoot)
  const pathReal = resolveExistingOrAncestors(absPath)

  if (escapesWorkspace(rootReal, pathReal)) {
    throw new PathEscapeError(`path escapes workspace: ${absPath}`)
  }

  return path.relative(rootReal, pathReal).split(path.sep).join('/')
}
