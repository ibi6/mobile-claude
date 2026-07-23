/**
 * Build a simple unified diff between two text snapshots.
 * Path is workspace-relative with forward slashes.
 */
export function createUnifiedDiff(
  relPath: string,
  before: string,
  after: string,
): string {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)

  if (before === after) {
    return `--- a/${relPath}\n+++ b/${relPath}\n`
  }

  // Full-file hunk is fine for coding-agent diffs; keeps implementation dependency-free.
  const body: string[] = []
  for (const line of beforeLines) {
    body.push(`-${line}`)
  }
  for (const line of afterLines) {
    body.push(`+${line}`)
  }

  const oldHeaderCount = before === '' ? 0 : beforeLines.length
  const newHeaderCount = after === '' ? 0 : afterLines.length
  const oldStart = oldHeaderCount === 0 ? 0 : 1
  const newStart = newHeaderCount === 0 ? 0 : 1

  return [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -${oldStart},${oldHeaderCount} +${newStart},${newHeaderCount} @@`,
    ...body,
  ].join('\n')
}

function splitLines(text: string): string[] {
  if (text === '') return []
  // Preserve trailing empty line semantics of split
  return text.split('\n')
}
