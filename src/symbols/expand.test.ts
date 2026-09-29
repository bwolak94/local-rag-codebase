import { describe, it, expect, vi } from 'vitest'
import { expandChunks } from './expand.js'
import type { ScoredChunk, SymbolIndex, Store } from '../types/index.js'

function makeChunk(id: string, content = 'x'.repeat(40)): ScoredChunk {
  return {
    chunk: {
      id,
      path: 'src/a.ts',
      lang: 'typescript',
      kind: 'function',
      startLine: 1,
      endLine: 5,
      header: '',
      content,
      hash: '',
    },
    score: 0.9,
    source: 'fused',
  }
}

function mockSymbolIndex(neighborMap: Record<string, string[]>): SymbolIndex {
  return {
    upsert: vi.fn(),
    deleteByPath: vi.fn(),
    definitions: vi.fn(),
    references: vi.fn(),
    neighbors: vi.fn().mockImplementation((chunkId: string) => {
      return Promise.resolve(neighborMap[chunkId] ?? [])
    }),
  }
}

function mockStore(chunks: ScoredChunk[]): Store {
  return {
    upsert: vi.fn(),
    deleteByPath: vi.fn(),
    vectorSearch: vi.fn().mockResolvedValue([]),
    textSearch: vi.fn().mockResolvedValue([]),
    getMeta: vi.fn().mockResolvedValue(null),
    getByIds: vi.fn().mockImplementation((ids: string[]) => {
      return Promise.resolve(chunks.filter(c => ids.includes(c.chunk.id)))
    }),
  }
}

describe('expandChunks', () => {
  it('adds neighbor chunks within token budget', async () => {
    const seed = makeChunk('seed')
    const neighbor = makeChunk('neighbor')

    const symbolIndex = mockSymbolIndex({ seed: ['neighbor'] })
    const store = mockStore([neighbor])

    // 40 chars / 4 = 10 tokens per chunk, budget = 1000 → plenty of room
    const result = await expandChunks([seed], symbolIndex, store, 1000)

    expect(result.map(r => r.chunk.id)).toContain('neighbor')
    expect(result).toHaveLength(2)
  })

  it('does not exceed maxTokens', async () => {
    const seed = makeChunk('seed', 'a'.repeat(200)) // 200 chars = 50 tokens
    const neighbor = makeChunk('n1', 'b'.repeat(200))  // 50 tokens
    const neighbor2 = makeChunk('n2', 'c'.repeat(200)) // 50 tokens

    const symbolIndex = mockSymbolIndex({ seed: ['n1', 'n2'] })
    const store = mockStore([neighbor, neighbor2])

    // budget = 80 tokens: seed uses 50, only 30 left → neither neighbor fits (both need 50)
    const result = await expandChunks([seed], symbolIndex, store, 80)

    expect(result).toHaveLength(1)
    expect(result[0]?.chunk.id).toBe('seed')
  })

  it('does not duplicate chunks already in the input list', async () => {
    const seed = makeChunk('seed')
    const already = makeChunk('already')

    // neighbors returns 'already', which is already in the input
    const symbolIndex = mockSymbolIndex({ seed: ['already'] })
    const store = mockStore([already])

    const result = await expandChunks([seed, already], symbolIndex, store, 10000)

    const ids = result.map(r => r.chunk.id)
    const alreadyCount = ids.filter(id => id === 'already').length
    expect(alreadyCount).toBe(1)
  })

  it('returns source: expanded for added chunks', async () => {
    const seed = makeChunk('seed')
    const neighbor = makeChunk('nb')

    const symbolIndex = mockSymbolIndex({ seed: ['nb'] })
    const store = mockStore([neighbor])

    const result = await expandChunks([seed], symbolIndex, store, 10000)
    const expanded = result.find(r => r.chunk.id === 'nb')
    expect(expanded?.source).toBe('expanded')
  })

  it('returns original chunks unchanged when no neighbors exist', async () => {
    const seed = makeChunk('seed')
    const symbolIndex = mockSymbolIndex({})
    const store = mockStore([])

    const result = await expandChunks([seed], symbolIndex, store, 10000)
    expect(result).toHaveLength(1)
    expect(result[0]?.chunk.id).toBe('seed')
    expect(result[0]?.source).toBe('fused')
  })

  it('handles empty input chunks list', async () => {
    const symbolIndex = mockSymbolIndex({})
    const store = mockStore([])

    const result = await expandChunks([], symbolIndex, store, 10000)
    expect(result).toEqual([])
  })
})
