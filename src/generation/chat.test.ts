import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateCitations, OllamaGenerator } from './chat.js'
import type { ScoredChunk, ChatTurn } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(path: string, startLine: number, endLine: number): ScoredChunk {
  return {
    chunk: {
      id: `${path}-${startLine}`,
      path,
      lang: 'typescript',
      kind: 'function',
      startLine,
      endLine,
      header: '',
      content: 'function foo() {}',
      hash: '',
    },
    score: 1,
    source: 'vector',
  }
}

function makeConfig(): RagConfig {
  return {
    root: '.',
    include: ['src/**'],
    exclude: [],
    maxFileBytes: 200_000,
    embedding: { model: 'nomic-embed-text', batchSize: 48 },
    llm: { model: 'qwen2.5-coder:14b', numCtx: 32768, temperature: 0.1, rewriteTemperature: 0.3 },
    retrieval: { kVector: 20, kFts: 20, kFinal: 8, expandDepth: 1, rewrite: false, rerank: 'false' },
    store: { driver: 'lancedb', path: '.rag' },
    budget: { contextFraction: 0.6, historyFraction: 0.2 },
  }
}

// ---------------------------------------------------------------------------
// validateCitations
// ---------------------------------------------------------------------------

describe('validateCitations', () => {
  it('returns no warnings for valid citations', () => {
    const context = [makeContext('src/foo.ts', 10, 30)]
    const answer = 'The function is defined at [src/foo.ts:10-30].'
    const warnings = validateCitations(answer, context)
    expect(warnings).toHaveLength(0)
  })

  it('warns on unknown file path in citation', () => {
    const context = [makeContext('src/foo.ts', 10, 30)]
    const answer = 'See [src/bar.ts:5-20] for details.'
    const warnings = validateCitations(answer, context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Cited file not in context: src/bar.ts')
  })

  it('warns on out-of-range line numbers', () => {
    const context = [makeContext('src/foo.ts', 10, 30)]
    const answer = 'The function is at [src/foo.ts:1-100].'
    const warnings = validateCitations(answer, context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('src/foo.ts')
    expect(warnings[0]).toContain('[1-100]')
    expect(warnings[0]).toContain('[10-30]')
  })

  it('handles answer with no citations', () => {
    const context = [makeContext('src/foo.ts', 10, 30)]
    const answer = 'There are no citations in this answer.'
    const warnings = validateCitations(answer, context)
    expect(warnings).toHaveLength(0)
  })

  it('returns no warnings for empty context and no citations', () => {
    const warnings = validateCitations('No code references here.', [])
    expect(warnings).toHaveLength(0)
  })

  it('handles multiple citations — some valid, some invalid', () => {
    const context = [
      makeContext('src/foo.ts', 10, 30),
      makeContext('src/bar.ts', 5, 15),
    ]
    const answer = 'See [src/foo.ts:10-30] and [src/baz.ts:1-5].'
    const warnings = validateCitations(answer, context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('src/baz.ts')
  })

  it('start line below chunk.startLine triggers warning', () => {
    const context = [makeContext('src/foo.ts', 10, 30)]
    const answer = '[src/foo.ts:5-30]'
    const warnings = validateCitations(answer, context)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[5-30]')
  })
})

// ---------------------------------------------------------------------------
// OllamaGenerator.answer() — streaming + citation warnings
// ---------------------------------------------------------------------------

const mockChat = vi.fn()

vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(() => ({
    chat: mockChat,
  })),
}))

// Helper: create an async iterable of streaming chat chunks
function makeStream(tokens: string[]): AsyncIterable<{ message: { content: string } }> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next() {
          if (i < tokens.length) {
            const token = tokens[i++]
            return Promise.resolve({ value: { message: { content: token ?? '' } }, done: false })
          }
          return Promise.resolve({ value: { message: { content: '' } }, done: true })
        },
      }
    },
  }
}

describe('OllamaGenerator.answer()', () => {
  beforeEach(() => {
    mockChat.mockReset()
  })

  it('streams citation warnings after answer when validation is enabled', async () => {
    // Answer references a file path NOT in the context chunks
    const answerTokens = ['See ', '[src/unknown.ts:1-10]', ' for details.']
    mockChat.mockResolvedValue(makeStream(answerTokens))

    const context = [makeContext('src/foo.ts', 1, 20)]
    const generator = new OllamaGenerator(makeConfig(), 'http://localhost:11434', true)

    const tokens: string[] = []
    for await (const token of generator.answer('test question', context)) {
      tokens.push(token)
    }

    const fullOutput = tokens.join('')
    expect(fullOutput).toContain('Citation warnings')
    expect(fullOutput).toContain('src/unknown.ts')
  })

  it('does NOT stream citation warnings when validation is disabled', async () => {
    const answerTokens = ['See ', '[src/unknown.ts:1-10]', ' for details.']
    mockChat.mockResolvedValue(makeStream(answerTokens))

    const context = [makeContext('src/foo.ts', 1, 20)]
    const generator = new OllamaGenerator(makeConfig(), 'http://localhost:11434', false)

    const tokens: string[] = []
    for await (const token of generator.answer('test question', context)) {
      tokens.push(token)
    }

    const fullOutput = tokens.join('')
    expect(fullOutput).not.toContain('Citation warnings')
  })

  it('does not append warning block when all citations are valid', async () => {
    const answerTokens = ['The function is at ', '[src/foo.ts:1-20]', '.']
    mockChat.mockResolvedValue(makeStream(answerTokens))

    const context = [makeContext('src/foo.ts', 1, 20)]
    const generator = new OllamaGenerator(makeConfig(), 'http://localhost:11434', true)

    const tokens: string[] = []
    for await (const token of generator.answer('test question', context)) {
      tokens.push(token)
    }

    const fullOutput = tokens.join('')
    expect(fullOutput).not.toContain('Citation warnings')
  })

  it('yields answer tokens before the warning block', async () => {
    const answerTokens = ['Answer text.', ' More text.']
    mockChat.mockResolvedValue(makeStream(answerTokens))

    const context: ScoredChunk[] = []
    const generator = new OllamaGenerator(makeConfig(), 'http://localhost:11434', true)
    const history: ChatTurn[] = []

    const tokens: string[] = []
    for await (const token of generator.answer('q', context, history)) {
      tokens.push(token)
    }

    // First tokens should be the raw answer text
    expect(tokens[0]).toBe('Answer text.')
    expect(tokens[1]).toBe(' More text.')
  })
})
