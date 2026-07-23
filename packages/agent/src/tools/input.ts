/** Coerce unknown tool input to a plain object. */
export function asRecord(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  throw new Error('tool input must be an object')
}

export function requireString(
  obj: Record<string, unknown>,
  key: string,
): string {
  const v = obj[key]
  if (typeof v !== 'string') {
    throw new Error(`missing or invalid string field: ${key}`)
  }
  return v
}

export function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') {
    throw new Error(`invalid string field: ${key}`)
  }
  return v
}

export function optionalPositiveInt(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new Error(`invalid positive integer field: ${key}`)
  }
  return v
}

export type TruncatedText = {
  text: string
  truncated: boolean
}

/**
 * Truncate large tool outputs for model + client safety.
 * Returns both the (possibly capped) text and a `truncated` flag.
 */
export function truncateText(
  text: string,
  maxChars: number,
  suffix = '\n[truncated]',
): TruncatedText {
  if (text.length <= maxChars) return { text, truncated: false }
  const keep = Math.max(0, maxChars - suffix.length)
  return { text: text.slice(0, keep) + suffix, truncated: true }
}

/** Truncate large tool outputs (text only). Prefer `truncateText` when a flag is needed. */
export function truncateOutput(
  text: string,
  maxChars: number,
  suffix = '\n[truncated]',
): string {
  return truncateText(text, maxChars, suffix).text
}
