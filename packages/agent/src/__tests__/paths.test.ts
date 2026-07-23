import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertInsideWorkspace, toRelative, PathEscapeError } from '../paths'

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

  it('blocks absolute path outside workspace', () => {
    const outside = path.join(os.tmpdir(), `mc-outside-${Date.now()}.txt`)
    fs.writeFileSync(outside, 'y')
    try {
      expect(() => assertInsideWorkspace(root, outside)).toThrow(PathEscapeError)
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })

  it('allows absolute path inside workspace', () => {
    const inside = path.join(root, 'a.txt')
    const abs = assertInsideWorkspace(root, inside)
    expect(abs).toBe(fs.realpathSync(inside))
  })

  it('resolves non-existent file with existing parent (Write case)', () => {
    const abs = assertInsideWorkspace(root, 'new-file.txt')
    expect(abs).toBe(path.join(fs.realpathSync(root), 'new-file.txt'))
  })

  it('resolves non-existent intermediate dirs (newDir/a.txt)', () => {
    const abs = assertInsideWorkspace(root, path.join('newDir', 'a.txt'))
    expect(abs).toBe(path.join(fs.realpathSync(root), 'newDir', 'a.txt'))
  })

  it('allows filename starting with .. inside workspace (..foo)', () => {
    fs.writeFileSync(path.join(root, '..foo'), 'z')
    const abs = assertInsideWorkspace(root, '..foo')
    expect(abs).toBe(fs.realpathSync(path.join(root, '..foo')))
  })
})

describe('toRelative', () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ws-'))
    fs.writeFileSync(path.join(root, 'a.txt'), 'x')
    fs.mkdirSync(path.join(root, 'sub'))
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'y')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('returns forward slashes', () => {
    const abs = assertInsideWorkspace(root, path.join('sub', 'b.txt'))
    const rel = toRelative(root, abs)
    expect(rel).toBe('sub/b.txt')
    expect(rel).not.toContain('\\')
  })

  it('throws PathEscapeError when absPath is outside workspace', () => {
    const outside = path.join(os.tmpdir(), `mc-outside-rel-${Date.now()}.txt`)
    fs.writeFileSync(outside, 'y')
    try {
      expect(() => toRelative(root, outside)).toThrow(PathEscapeError)
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })
})

describe('PathEscapeError', () => {
  it('has name PathEscapeError', () => {
    const err = new PathEscapeError('test')
    expect(err.name).toBe('PathEscapeError')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('test')
  })
})
