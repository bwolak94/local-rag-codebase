import { createHash } from 'node:crypto'

export function contentHash(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function chunkHash(header: string, content: string): string {
  // Use a null-byte separator to prevent header+content boundary collisions
  // e.g. chunkHash('AB', '') must differ from chunkHash('A', 'B')
  return createHash('sha256').update(header + '\0' + content).digest('hex')
}

export function chunkId(path: string, symbol: string | undefined, startLine: number): string {
  const key = `${path}|${symbol ?? ''}|${startLine}`
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}
