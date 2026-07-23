import { describe, it, expect } from 'vitest'
import {
  resolvePermission,
  patternForTool,
  riskForTool,
} from '../permissions'

describe('resolvePermission', () => {
  it('auto-allows Read when autoAllowReadTools is true', () => {
    expect(
      resolvePermission({
        tool: 'Read',
        pattern: 'src/a.ts',
        autoAllowReadTools: true,
        rules: [],
      }),
    ).toBe('allow')
  })

  it('auto-allows Glob and Grep when autoAllowReadTools is true', () => {
    expect(
      resolvePermission({
        tool: 'Glob',
        pattern: '**/*.ts',
        autoAllowReadTools: true,
        rules: [],
      }),
    ).toBe('allow')
    expect(
      resolvePermission({
        tool: 'Grep',
        pattern: 'src',
        autoAllowReadTools: true,
        rules: [],
      }),
    ).toBe('allow')
  })

  it('asks for Read when autoAllowReadTools is false', () => {
    expect(
      resolvePermission({
        tool: 'Read',
        pattern: 'src/a.ts',
        autoAllowReadTools: false,
        rules: [],
      }),
    ).toBe('ask')
  })

  it('asks for Write by default', () => {
    expect(
      resolvePermission({
        tool: 'Write',
        pattern: 'src/a.ts',
        autoAllowReadTools: true,
        rules: [],
      }),
    ).toBe('ask')
  })

  it('asks for Edit by default', () => {
    expect(
      resolvePermission({
        tool: 'Edit',
        pattern: 'src/a.ts',
        autoAllowReadTools: true,
        rules: [],
      }),
    ).toBe('ask')
  })

  it('allows when session rule matches exact tool + path', () => {
    expect(
      resolvePermission({
        tool: 'Write',
        pattern: 'src/a.ts',
        autoAllowReadTools: true,
        rules: [{ tool: 'Write', pattern: 'src/a.ts' }],
      }),
    ).toBe('allow')
  })

  it('asks when rule tool matches but path differs', () => {
    expect(
      resolvePermission({
        tool: 'Write',
        pattern: 'src/b.ts',
        autoAllowReadTools: true,
        rules: [{ tool: 'Write', pattern: 'src/a.ts' }],
      }),
    ).toBe('ask')
  })

  it('asks when rule path matches but tool differs', () => {
    expect(
      resolvePermission({
        tool: 'Edit',
        pattern: 'src/a.ts',
        autoAllowReadTools: true,
        rules: [{ tool: 'Write', pattern: 'src/a.ts' }],
      }),
    ).toBe('ask')
  })

  it('never auto-allows Bash even with autoAllowReadTools', () => {
    expect(
      resolvePermission({
        tool: 'Bash',
        pattern: 'echo hi',
        autoAllowReadTools: true,
        rules: [],
      }),
    ).toBe('ask')
  })

  it('allows Bash only when exact command rule matches', () => {
    expect(
      resolvePermission({
        tool: 'Bash',
        pattern: 'echo hi',
        autoAllowReadTools: true,
        rules: [{ tool: 'Bash', pattern: 'echo hi' }],
      }),
    ).toBe('allow')
    expect(
      resolvePermission({
        tool: 'Bash',
        pattern: 'echo bye',
        autoAllowReadTools: true,
        rules: [{ tool: 'Bash', pattern: 'echo hi' }],
      }),
    ).toBe('ask')
  })
})

describe('patternForTool', () => {
  it('returns path for Read/Write/Edit', () => {
    expect(patternForTool('Read', { path: 'src/a.ts' })).toBe('src/a.ts')
    expect(patternForTool('Write', { path: 'out.txt', content: 'x' })).toBe('out.txt')
    expect(patternForTool('Edit', { path: 'x.ts', old_string: 'a', new_string: 'b' })).toBe(
      'x.ts',
    )
  })

  it('returns glob pattern for Glob', () => {
    expect(patternForTool('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  })

  it('returns path for Grep when present, else search pattern', () => {
    expect(patternForTool('Grep', { pattern: 'foo', path: 'src' })).toBe('src')
    expect(patternForTool('Grep', { pattern: 'foo' })).toBe('foo')
  })

  it('returns exact command for Bash', () => {
    expect(patternForTool('Bash', { command: 'npm test', cwd: '.' })).toBe('npm test')
  })

  it('returns empty string for missing fields', () => {
    expect(patternForTool('Read', {})).toBe('')
    expect(patternForTool('Bash', {})).toBe('')
    expect(patternForTool('Read', null)).toBe('')
  })
})

describe('riskForTool', () => {
  it('maps tools to low/medium/high', () => {
    expect(riskForTool('Read')).toBe('low')
    expect(riskForTool('Glob')).toBe('low')
    expect(riskForTool('Grep')).toBe('low')
    expect(riskForTool('Write')).toBe('medium')
    expect(riskForTool('Edit')).toBe('medium')
    expect(riskForTool('Bash')).toBe('high')
  })

  it('defaults unknown tools to high', () => {
    expect(riskForTool('Unknown')).toBe('high')
  })
})
