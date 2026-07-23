import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listWorkspaceDir, readWorkspaceFile } from '../fsApi'
import { PathEscapeError } from '../paths'

describe('fsApi', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fsapi-'))
    fs.mkdirSync(path.join(root, 'sub'))
    fs.writeFileSync(path.join(root, 'a.txt'), 'alpha')
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'bravo content here')
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('lists root with dirs first', () => {
    const r = listWorkspaceDir(root, '.')
    expect(r.entries.map((e) => e.name)).toEqual(['sub', 'a.txt'])
    expect(r.entries[0]!.type).toBe('directory')
    expect(r.entries[1]!.type).toBe('file')
    expect(r.entries[1]!.size).toBe(5)
  })

  it('reads file with truncation', () => {
    const r = readWorkspaceFile(root, 'sub/b.txt', 5)
    expect(r.truncated).toBe(true)
    expect(r.content.length).toBeLessThanOrEqual(5)
    expect(r.path.replace(/\\/g, '/')).toBe('sub/b.txt')
  })

  it('rejects path escape', () => {
    expect(() => listWorkspaceDir(root, '..')).toThrow(PathEscapeError)
    expect(() => readWorkspaceFile(root, '../secret')).toThrow(PathEscapeError)
  })
})
