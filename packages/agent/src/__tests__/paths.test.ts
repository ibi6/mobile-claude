import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertInsideWorkspace, PathEscapeError } from '../paths'

describe('assertInsideWorkspace', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ws-'))
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('allows relative path inside', () => {
    const abs = assertInsideWorkspace(root, 'a.txt')
    expect(abs).toBe(fs.realpathSync(path.join(root, 'a.txt')))
  })

  it('blocks .. escape', () => {
    expect(() => assertInsideWorkspace(root, '../outside')).toThrow(PathEscapeError)
  })
})
