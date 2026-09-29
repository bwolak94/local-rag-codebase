import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HybridRetriever } from './hybrid.js'
import type { Store, Embedder, SymbolIndex, ScoredChunk } from '../types/index.js'

vi.mock('./rrf.js', () => ({
  rrf: vi.fn((lists: ScoredChunk[][]) => {
    // Simple mock RRF that combines and sorts by score descending
    const combined = lists.flat()
    const seen = new Set<string>()
    return combined
      .filter(item => {
        if (seen.has(item.chunk.id)) return false
        seen.add(item.chunk.id)
        return true
      })
      .sort((a, b) => b.score - a.score)
      .map(item => ({ ...item, source: 'fused' as const }))
  }),
}))

vi.mock('../symbols/expand.js', () => ({
  expandChunks: vi.fn((chunks: ScoredChunk[]) =>
    Promise.resolve(chunks)
  ),
}))

function makeChunk(id: string, score: number): ScoredChunk {
  return {
    chunk: {
      id,
      path: 'src/test.ts',
      lang: 'typescript',
      kind: 'function',
      startLine: 1,
      endLine: 10,
      header: '',
      content: 'test',
      hash: '',
    },
    score,
    source: 'vector',
  }
}

function mockStore(): Store {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    deleteByPath: vi.fn().mockResolvedValue(undefined),
    vectorSearch: vi.fn().mockResolvedValue([]),
    textSearch: vi.fn().mockResolvedValue([]),
    getMeta: vi.fn().mockResolvedValue(null),
    getByIds: vi.fn().mockResolvedValue([]),
  }
}

function mockEmbedder(): Embedder {
  return {
    model: 'test-model',
    dim: 4,
    embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]),
  }
}

function mockSymbolIndex(): SymbolIndex {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    deleteByPath: vi.fn().mockResolvedValue(undefined),
    definitions: vi.fn().mockResolvedValue([]),
    references: vi.fn().mockResolvedValue([]),
    neighbors: vi.fn().mockResolvedValue([]),
  }
}

describe('HybridRetriever', () => {
  let store: Store
  let embedder: Embedder
  let symbolIndex: SymbolIndex

  beforeEach(() => {
    store = mockStore()
    embedder = mockEmbedder()
    symbolIndex = mockSymbolIndex()
  })

  it('calls embedder.embed with mode query', async () => {
    const retriever = new HybridRetriever(store, embedder, 20, 20)
    await retriever.retrieve('test query', { k: 8 })
    expect(embedder.embed).toHaveBeenCalledWith(['test query'], 'query')
  })

  it('calls both store.vectorSearch and store.textSearch in parallel', async () => {
    const retriever = new HybridRetriever(store, embedder, 20, 20)
    await retriever.retrieve('test query', { k: 8 })
    expect(store.vectorSearch).toHaveBeenCalled()
    expect(store.textSearch).toHaveBeenCalled()
  })

  it('applies RRF fusion to the two result lists', async () => {
    const vectorResults = [makeChunk('a', 0.9), makeChunk('b', 0.8)]
    const ftsResults = [makeChunk('b', 0.85), makeChunk('c', 0.7)]
    vi.mocked(store.vectorSearch).mockResolvedValue(vectorResults)
    vi.mocked(store.textSearch).mockResolvedValue(ftsResults)

    const retriever = new HybridRetriever(store, embedder, 20, 20)
    const result = await retriever.retrieve('test', { k: 8 })

    // Result should have fused source after RRF
    expect(result.some(r => r.source === 'fused')).toBe(true)
  })

  it('result length is capped at opts.k', async () => {
    const manyResults = Array.from({ length: 100 }, (_, i) =>
      makeChunk(`chunk${i}`, 0.5)
    )
    vi.mocked(store.vectorSearch).mockResolvedValue(manyResults.slice(0, 50))
    vi.mocked(store.textSearch).mockResolvedValue(manyResults.slice(50, 100))

    const retriever = new HybridRetriever(store, embedder, 20, 20)
    const result = await retriever.retrieve('test', { k: 10 })

    expect(result.length).toBeLessThanOrEqual(10)
  })

  it('when opts.expand is false, expandChunks is NOT called', async () => {
    const { expandChunks } = await import('../symbols/expand.js')
    const expandMock = vi.mocked(expandChunks)
    expandMock.mockClear()

    const retriever = new HybridRetriever(store, embedder, 20, 20, symbolIndex)
    await retriever.retrieve('test', { k: 8, expand: false })

    expect(expandMock).not.toHaveBeenCalled()
  })

  it('when opts.expand is true and symbolIndex is set, expandChunks IS called', async () => {
    const { expandChunks } = await import('../symbols/expand.js')
    const expandMock = vi.mocked(expandChunks)
    expandMock.mockClear()
    expandMock.mockResolvedValue([makeChunk('expanded', 0.8)])

    const vectorResults = [makeChunk('seed', 0.9)]
    vi.mocked(store.vectorSearch).mockResolvedValue(vectorResults)
    vi.mocked(store.textSearch).mockResolvedValue([])

    const retriever = new HybridRetriever(store, embedder, 20, 20, symbolIndex)
    await retriever.retrieve('test', { k: 8, expand: true })

    expect(expandMock).toHaveBeenCalled()
  })

  it('when opts.expand is true but symbolIndex is undefined, expandChunks is NOT called', async () => {
    const { expandChunks } = await import('../symbols/expand.js')
    const expandMock = vi.mocked(expandChunks)
    expandMock.mockClear()

    const retriever = new HybridRetriever(store, embedder, 20, 20) // no symbolIndex
    await retriever.retrieve('test', { k: 8, expand: true })

    expect(expandMock).not.toHaveBeenCalled()
  })

  it('empty store results return empty array', async () => {
    vi.mocked(store.vectorSearch).mockResolvedValue([])
    vi.mocked(store.textSearch).mockResolvedValue([])

    const retriever = new HybridRetriever(store, embedder, 20, 20)
    const result = await retriever.retrieve('test', { k: 8 })

    expect(result).toEqual([])
  })

  it('filter is forwarded to vectorSearch', async () => {
    const retriever = new HybridRetriever(store, embedder, 20, 20)
    const filter = { pathPrefix: 'src/', lang: ['typescript'] }
    await retriever.retrieve('test', { k: 8, filter })

    expect(store.vectorSearch).toHaveBeenCalledWith(
      expect.any(Array),
      20,
      filter
    )
  })

  it('filter is forwarded to textSearch', async () => {
    const retriever = new HybridRetriever(store, embedder, 20, 20)
    const filter = { pathPrefix: 'src/utils' }
    await retriever.retrieve('test', { k: 8, filter })

    expect(store.textSearch).toHaveBeenCalledWith(
      'test',
      20,
      filter
    )
  })

  it('uses kVector for vectorSearch limit', async () => {
    const retriever = new HybridRetriever(store, embedder, 35, 20)
    await retriever.retrieve('test', { k: 8 })

    expect(store.vectorSearch).toHaveBeenCalledWith(
      expect.any(Array),
      35, // kVector=35
      undefined
    )
  })

  it('uses kFts for textSearch limit', async () => {
    const retriever = new HybridRetriever(store, embedder, 20, 45)
    await retriever.retrieve('test', { k: 8 })

    expect(store.textSearch).toHaveBeenCalledWith(
      'test',
      45, // kFts=45
      undefined
    )
  })

  it('respects expandDepth parameter', async () => {
    const { expandChunks } = await import('../symbols/expand.js')
    const expandMock = vi.mocked(expandChunks)
    expandMock.mockClear()
    expandMock.mockResolvedValue([])

    const vectorResults = [makeChunk('seed', 0.9)]
    vi.mocked(store.vectorSearch).mockResolvedValue(vectorResults)
    vi.mocked(store.textSearch).mockResolvedValue([])

    const retriever = new HybridRetriever(store, embedder, 20, 20, symbolIndex, 4096, 2)
    await retriever.retrieve('test', { k: 8, expand: true })

    expect(expandMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      expect.any(Object),
      expect.any(Number),
      2 // expandDepth=2
    )
  })
})
