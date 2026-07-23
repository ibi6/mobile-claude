import { EnvelopeSchema, type Envelope } from './envelope.js'

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProtocolError'
  }
}

export function parseEnvelope(raw: string): Envelope {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new ProtocolError('invalid JSON')
  }
  const result = EnvelopeSchema.safeParse(data)
  if (!result.success) {
    if ((data as { v?: number })?.v !== 1) {
      throw new ProtocolError('unsupported protocol version')
    }
    throw new ProtocolError(result.error.message)
  }
  return result.data as Envelope
}
