import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const

export const EnvelopeSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  type: z.string().min(1),
  ts: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
  payload: z.unknown(),
})

export type Envelope<T = unknown> = {
  v: 1
  id: string
  type: string
  ts: number
  sessionId?: string
  payload: T
}

export function createEnvelope<T>(
  type: string,
  payload: T,
  opts?: { id?: string; sessionId?: string; ts?: number }
): Envelope<T> {
  return {
    v: 1,
    id: opts?.id ?? crypto.randomUUID(),
    type,
    ts: opts?.ts ?? Date.now(),
    sessionId: opts?.sessionId,
    payload,
  }
}
