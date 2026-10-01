import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock ollama before importing the SUT ────────────────────────────────────

const mockEmbed = vi.fn()

vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(() => ({
    embed: mockEmbed,
  })),
}))

// ── Import SUT after mock ────────────────────────────────────────────────────

import { OllamaEmbedder } from './ollama.js'

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OllamaEmbedder', () => {
  beforeEach(() => {
    mockEmbed.mockReset()
    // Default: return two 4-dimensional vectors
    mockEmbed.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3, 0.4]] })
  })

  it('model property is set on construction', () => {
    const embedder = new OllamaEmbedder('nomic-embed-text')
    expect(embedder.model).toBe('nomic-embed-text')
  })

  it('dim is 0 before any embed call', () => {
    const embedder = new OllamaEmbedder('nomic-embed-text')
    expect(embedder.dim).toBe(0)
  })

  it('embed with mode document prepends search_document: for nomic-embed-text', async () => {
    const embedder = new OllamaEmbedder('nomic-embed-text')
    await embedder.embed(['hello world'], 'document')

    const callArgs = mockEmbed.mock.calls[0]?.[0] as { input: string[] }
    expect(callArgs.input[0]).toBe('search_document: hello world')
  })

  it('embed with mode query prepends search_query: for nomic-embed-text', async () => {
    const embedder = new OllamaEmbedder('nomic-embed-text')
    await embedder.embed(['what is typescript'], 'query')

    const callArgs = mockEmbed.mock.calls[0]?.[0] as { input: string[] }
    expect(callArgs.input[0]).toBe('search_query: what is typescript')
  })

  it('bge-m3 model uses empty prefix for document mode', async () => {
    const embedder = new OllamaEmbedder('bge-m3')
    await embedder.embed(['hello world'], 'document')

    const callArgs = mockEmbed.mock.calls[0]?.[0] as { input: string[] }
    expect(callArgs.input[0]).toBe('hello world')
  })

  it('bge-m3 model uses empty prefix for query mode', async () => {
    const embedder = new OllamaEmbedder('bge-m3')
    await embedder.embed(['what is typescript'], 'query')

    const callArgs = mockEmbed.mock.calls[0]?.[0] as { input: string[] }
    expect(callArgs.input[0]).toBe('what is typescript')
  })

  it('unknown model uses empty prefix', async () => {
    const embedder = new OllamaEmbedder('some-unknown-model')
    await embedder.embed(['test text'], 'document')

    const callArgs = mockEmbed.mock.calls[0]?.[0] as { input: string[] }
    expect(callArgs.input[0]).toBe('test text')
  })

  it('dim is updated to vector length after first embed call', async () => {
    mockEmbed.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]] })
    const embedder = new OllamaEmbedder('nomic-embed-text')
    expect(embedder.dim).toBe(0)
    await embedder.embed(['hello'], 'document')
    expect(embedder.dim).toBe(8)
  })

  it('dim does not change on subsequent embed calls', async () => {
    mockEmbed.mockResolvedValue({ embeddings: [[0.1, 0.2, 0.3, 0.4]] })
    const embedder = new OllamaEmbedder('nomic-embed-text')
    await embedder.embed(['first'], 'document')
    expect(embedder.dim).toBe(4)

    // Second call with different vector length — dim should not change
    mockEmbed.mockResolvedValue({ embeddings: [[0.5, 0.6, 0.7, 0.8, 0.9, 1.0]] })
    await embedder.embed(['second'], 'document')
    expect(embedder.dim).toBe(4)
  })

  it('returns vectors from the Ollama client', async () => {
    // Use already-unit-length vectors so L2 normalisation is a no-op
    mockEmbed.mockResolvedValue({ embeddings: [[1, 0, 0], [0, 1, 0]] })
    const embedder = new OllamaEmbedder('nomic-embed-text')
    const result = await embedder.embed(['text1', 'text2'], 'document')
    expect(result).toEqual([[1, 0, 0], [0, 1, 0]])
  })

  it('empty input returns [] without calling Ollama', async () => {
    const embedder = new OllamaEmbedder('nomic-embed-text')
    const result = await embedder.embed([], 'document')
    expect(result).toEqual([])
    expect(mockEmbed).not.toHaveBeenCalled()
  })

  it('texts larger than batchSize are split into multiple Ollama calls', async () => {
    mockEmbed.mockResolvedValue({ embeddings: [[0.1, 0.2]] })
    // batchSize=2, 5 texts → 3 batches: [2, 2, 1]
    const embedder = new OllamaEmbedder('nomic-embed-text', 2)
    const texts = ['a', 'b', 'c', 'd', 'e']
    await embedder.embed(texts, 'document')
    expect(mockEmbed).toHaveBeenCalledTimes(3)
  })

  it('results from multiple batches are concatenated correctly', async () => {
    // Use already-unit-length vectors so L2 normalisation is a no-op
    mockEmbed
      .mockResolvedValueOnce({ embeddings: [[1, 0], [0, 1]] })
      .mockResolvedValueOnce({ embeddings: [[0.6, 0.8]] })

    const embedder = new OllamaEmbedder('nomic-embed-text', 2)
    const result = await embedder.embed(['a', 'b', 'c'], 'document')
    expect(result[0]).toEqual([1, 0])
    expect(result[1]).toEqual([0, 1])
    expect(result[2]![0]).toBeCloseTo(0.6)
    expect(result[2]![1]).toBeCloseTo(0.8)
  })
})
