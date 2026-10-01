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

  it('chunkId is 32 hex chars', () => {
    const id = chunkId('src/foo.ts', 'myFn', 10)
    expect(id).toHaveLength(32)
    expect(id).toMatch(/^[0-9a-f]+$/)
  })

  it('chunkId is deterministic for same inputs', () => {
    const id1 = chunkId('src/foo.ts', 'myFn', 10)
    const id2 = chunkId('src/foo.ts', 'myFn', 10)
    expect(id1).toBe(id2)
  })

  it('chunkHash does not collide when header/content boundary shifts', () => {
    expect(chunkHash('AB', '')).not.toBe(chunkHash('A', 'B'))
  })

  it('contentHash handles empty string', () => {
    const hash = contentHash('')
    expect(hash).toMatch(/^[a-f0-9]+$/)
    expect(contentHash('')).toBe(hash) // deterministic
  })

  it('chunkId produces exactly 32 hex characters', () => {
    expect(chunkId('src/a.ts', undefined, 0)).toMatch(/^[a-f0-9]{32}$/)
  })
})
