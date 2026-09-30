import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ScoredChunk } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'

// ── Mock ollama ─────────────────────────────────────────────────────────────

const mockGenerate = vi.fn()

vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(() => ({
    generate: mockGenerate,
  })),
}))

// ── Import SUT after mocks ───────────────────────────────────────────────────

import { rerankWithLLM, crossEncoderRerank, rerank } from './rerank.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeChunk(id: string, path = 'src/a.ts', score = 0.5): ScoredChunk {
  return {
    chunk: {
      id,
      path,
      lang: 'typescript',
      kind: 'function',
      startLine: 1,
      endLine: 20,
      header: '',
      content: `function ${id}() { /* body */ }`,
      hash: '',
    },
    score,
    source: 'fused',
  }
}

function makeConfig(rerank: 'false' | 'llm' | 'cross-encoder' = 'false'): RagConfig {
  return {
    root: '.',
    include: ['src/**'],
    exclude: [],
    maxFileBytes: 200_000,
    embedding: { model: 'nomic-embed-text', batchSize: 48 },
    llm: {
      model: 'qwen2.5-coder:14b',
      numCtx: 32768,
      temperature: 0.1,
      rewriteTemperature: 0.3,
    },
    retrieval: {
      kVector: 20,
      kFts: 20,
      kFinal: 8,
      expandDepth: 1,
      rewrite: false,
      rerank,
    },
    store: { driver: 'lancedb', path: '.rag' },
    budget: { contextFraction: 0.6, historyFraction: 0.2 },
  } as RagConfig
}

// ── rerankWithLLM ────────────────────────────────────────────────────────────

describe('rerankWithLLM', () => {
  beforeEach(() => {
    mockGenerate.mockReset()
  })

  it('returns chunks sorted by LLM score descending', async () => {
    const chunks = [makeChunk('a'), makeChunk('b'), makeChunk('c')]

    // chunk a → 0.3, chunk b → 0.9, chunk c → 0.6
    mockGenerate
      .mockResolvedValueOnce({ response: '0.3' })
      .mockResolvedValueOnce({ response: '0.9' })
      .mockResolvedValueOnce({ response: '0.6' })

    const result = await rerankWithLLM('test query', chunks, makeConfig('llm'))

    expect(result[0]?.chunk.id).toBe('b')
    expect(result[1]?.chunk.id).toBe('c')
    expect(result[2]?.chunk.id).toBe('a')
  })

  it('treats non-numeric LLM response as score 0', async () => {
    const chunks = [makeChunk('x'), makeChunk('y')]

    mockGenerate
      .mockResolvedValueOnce({ response: 'not a number' })
      .mockResolvedValueOnce({ response: '0.7' })

    const result = await rerankWithLLM('query', chunks, makeConfig('llm'))

    // y (0.7) should come first, x (0) should come last
    expect(result[0]?.chunk.id).toBe('y')
    expect(result[1]?.chunk.id).toBe('x')
    expect(result[1]?.score).toBe(0)
  })

  it('clamps score to [0, 1] when LLM returns a value above 1', async () => {
    const chunks = [makeChunk('over')]

    mockGenerate.mockResolvedValueOnce({ response: '1.5' })

    const result = await rerankWithLLM('query', chunks, makeConfig('llm'))

    expect(result[0]?.score).toBe(1)
  })

  it('clamps score to [0, 1] when LLM returns a negative value', async () => {
    const chunks = [makeChunk('under')]

    mockGenerate.mockResolvedValueOnce({ response: '-0.3' })

    const result = await rerankWithLLM('query', chunks, makeConfig('llm'))

    expect(result[0]?.score).toBe(0)
  })

  it('returns empty array without any LLM call when chunks is empty', async () => {
    const result = await rerankWithLLM('query', [], makeConfig('llm'))

    expect(result).toEqual([])
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('always passes num_ctx in options for every Ollama generate call', async () => {
    const chunks = [makeChunk('p'), makeChunk('q')]

    mockGenerate
      .mockResolvedValueOnce({ response: '0.5' })
      .mockResolvedValueOnce({ response: '0.4' })

    const config = makeConfig('llm')
    await rerankWithLLM('query', chunks, config)

    for (const call of mockGenerate.mock.calls) {
      const args = call[0] as { options?: { num_ctx?: number } }
      expect(args.options?.num_ctx).toBe(config.llm.numCtx)
    }
  })

  it('treats a chunk as score 0 when generate throws an error', async () => {
    const chunks = [makeChunk('fail'), makeChunk('ok')]

    mockGenerate
      .mockRejectedValueOnce(new Error('Ollama error'))
      .mockResolvedValueOnce({ response: '0.8' })

    const result = await rerankWithLLM('query', chunks, makeConfig('llm'))

    // ok (0.8) should come first
    expect(result[0]?.chunk.id).toBe('ok')
    expect(result[0]?.score).toBe(0.8)
    // fail (0) should come last
    expect(result[1]?.chunk.id).toBe('fail')
    expect(result[1]?.score).toBe(0)
  })
})

// ── crossEncoderRerank ───────────────────────────────────────────────────────

describe('crossEncoderRerank', () => {
  it('returns chunks unchanged (stub implementation)', async () => {
    const chunks = [makeChunk('a', 'src/a.ts', 0.9), makeChunk('b', 'src/b.ts', 0.5)]

    const result = await crossEncoderRerank('query', chunks)

    expect(result).toEqual(chunks)
    expect(result).toHaveLength(2)
  })

  it('returns empty array unchanged', async () => {
    const result = await crossEncoderRerank('query', [])
    expect(result).toEqual([])
  })
})

// ── rerank ───────────────────────────────────────────────────────────────────

describe('rerank', () => {
  beforeEach(() => {
    mockGenerate.mockReset()
  })

  it('returns chunks unchanged when config.retrieval.rerank is "false"', async () => {
    const chunks = [makeChunk('a'), makeChunk('b')]
    const config = makeConfig('false')

    const result = await rerank('query', chunks, config)

    expect(result).toEqual(chunks)
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('calls rerankWithLLM when config.retrieval.rerank is "llm"', async () => {
    const chunks = [makeChunk('a'), makeChunk('b')]
    const config = makeConfig('llm')

    mockGenerate
      .mockResolvedValueOnce({ response: '0.8' })
      .mockResolvedValueOnce({ response: '0.3' })

    const result = await rerank('query', chunks, config)

    expect(mockGenerate).toHaveBeenCalledTimes(2)
    // sorted by LLM score: a (0.8) first
    expect(result[0]?.chunk.id).toBe('a')
    expect(result[1]?.chunk.id).toBe('b')
  })

  it('calls crossEncoderRerank (returns chunks unchanged) when config.retrieval.rerank is "cross-encoder"', async () => {
    const chunks = [makeChunk('a'), makeChunk('b')]
    const config = makeConfig('cross-encoder')

    const result = await rerank('query', chunks, config)

    // cross-encoder stub returns unchanged
    expect(result).toEqual(chunks)
    // no LLM call should be made
    expect(mockGenerate).not.toHaveBeenCalled()
  })
})
