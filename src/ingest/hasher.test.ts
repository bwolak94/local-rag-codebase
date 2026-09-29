import { describe, it, expect } from 'vitest'
import { contentHash, chunkHash, chunkId } from './hasher.js'

describe('hasher', () => {
  it('contentHash is deterministic and hex', () => {
    const h = contentHash('hello')
    expect(h).toBe(contentHash('hello'))
    expect(h).toMatch(/^[0-9a-f]+$/)
  })

  it('chunkHash includes header in input', () => {
    const h1 = chunkHash('header', 'content')
    const h2 = chunkHash('different', 'content')
    expect(h1).not.toBe(h2)
  })

  it('different header + same content → different hash', () => {
    expect(chunkHash('A', 'X')).not.toBe(chunkHash('B', 'X'))
  })

  it('chunkId is 16 hex chars', () => {
    const id = chunkId('src/foo.ts', 'myFn', 10)
    expect(id).toHaveLength(16)
    expect(id).toMatch(/^[0-9a-f]+$/)
  })
})
