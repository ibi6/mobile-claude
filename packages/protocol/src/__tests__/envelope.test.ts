import { describe, it, expect } from 'vitest'
import { createEnvelope, parseEnvelope, PROTOCOL_VERSION } from '../index'

describe('envelope', () => {
  it('round-trips chat.send', () => {
    const env = createEnvelope('chat.send', { sessionId: 's1', text: 'hi' }, { sessionId: 's1' })
    expect(env.v).toBe(PROTOCOL_VERSION)
    expect(env.type).toBe('chat.send')
    const raw = JSON.stringify(env)
    const parsed = parseEnvelope(raw)
    expect(parsed.payload).toEqual({ sessionId: 's1', text: 'hi' })
  })

  it('rejects wrong version', () => {
    expect(() =>
      parseEnvelope(JSON.stringify({ v: 99, id: 'x', type: 'status', ts: 1, payload: {} }))
    ).toThrow(/version/i)
  })
})
