/**
 * Filesystem browse API for the mobile client (list + text preview).
 * All paths are sandboxed under workspaceRoot via assertInsideWorkspace.
 */

import fs from 'node:fs'
import path from 'node:path'
import { assertInsideWorkspace, PathEscapeError, toRelative } from './paths.js'

export type FsListEntry = {
  name: string
  /** Workspace-relative path with forward slashes */
  path: string
  type: 'file' | 'directory'
  size?: number
}

export type FsListResult = {
  path: string
  entries: FsListEntry[]
}

export type FsReadResult = {
  path: string
  content: string
  truncated: boolean
  size: number
}

const DEFAULT_MAX_READ_BYTES = 256_000

/**
 * List a directory under the workspace.
 * `userPath` is relative to workspace (or absolute inside it). Empty / `.` = root.
 */
export function listWorkspaceDir(
  workspaceRoot: string,
  userPath: string,
): FsListResult {
  const relInput = userPath === '' || userPath === '.' ? '.' : userPath
  const abs =
    relInput === '.'
      ? fs.realpathSync(workspaceRoot)
      : assertInsideWorkspace(workspaceRoot, relInput)

  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`fs.list failed: ${msg}`)
  }

  if (!stat.isDirectory()) {
    throw new Error(
      `fs.list failed: not a directory: ${toRelative(workspaceRoot, abs) || '.'}`,
    )
  }

  const names = fs.readdirSync(abs)
  const entries: FsListEntry[] = []

  for (const name of names) {
    // Skip hidden / internal junk at root of listing if desired — keep all for v1
    const childAbs = path.join(abs, name)
    let childStat: fs.Stats
    try {
      childStat = fs.lstatSync(childAbs)
    } catch {
      continue
    }

    // Do not follow symlinks that escape (realpath check)
    let safeAbs: string
    try {
      if (childStat.isSymbolicLink()) {
        safeAbs = assertInsideWorkspace(workspaceRoot, childAbs)
        childStat = fs.statSync(safeAbs)
      } else {
        safeAbs = childAbs
        // still verify inside workspace
        assertInsideWorkspace(workspaceRoot, safeAbs)
      }
    } catch (err) {
      if (err instanceof PathEscapeError) continue
      continue
    }

    const rel = toRelative(workspaceRoot, safeAbs)
    if (childStat.isDirectory()) {
      entries.push({ name, path: rel || name, type: 'directory' })
    } else if (childStat.isFile()) {
      entries.push({
        name,
        path: rel || name,
        type: 'file',
        size: childStat.size,
      })
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const listPath =
    relInput === '.' ? '' : toRelative(workspaceRoot, abs)

  return { path: listPath, entries }
}

/**
 * Read a text file preview under the workspace (UTF-8).
 */
export function readWorkspaceFile(
  workspaceRoot: string,
  userPath: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): FsReadResult {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('fs.read failed: maxBytes must be a positive integer')
  }

  const abs = assertInsideWorkspace(workspaceRoot, userPath)

  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`fs.read failed: ${msg}`)
  }

  if (!stat.isFile()) {
    throw new Error(
      `fs.read failed: not a file: ${toRelative(workspaceRoot, abs)}`,
    )
  }

  const size = stat.size
  const truncated = size > maxBytes
  const buf = Buffer.alloc(Math.min(size, maxBytes))
  const fd = fs.openSync(abs, 'r')
  try {
    fs.readSync(fd, buf, 0, buf.length, 0)
  } finally {
    fs.closeSync(fd)
  }

  // Strip incomplete trailing multi-byte UTF-8 sequence if truncated mid-char
  let content = buf.toString('utf8')
  if (truncated) {
    // remove replacement char at end from partial sequence
    content = content.replace(/\uFFFD$/u, '')
  }

  return {
    path: toRelative(workspaceRoot, abs),
    content,
    truncated,
    size,
  }
}
