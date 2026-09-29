import { createHash } from 'node:crypto'

export function contentHash(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function chunkHash(header: string, content: string): string {
  return createHash('sha256').update(header + content).digest('hex')
}

export function chunkId(path: string, symbol: string | undefined, startLine: number): string {
  const key = `${path}|${symbol ?? ''}|${startLine}`
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}
