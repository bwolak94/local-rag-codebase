import { describe, it, expect } from 'vitest'
import { RagConfigSchema } from './schema.js'

describe('RagConfigSchema', () => {
  it('returns all defaults when passed empty object', () => {
    const result = RagConfigSchema.parse({})
    expect(result.root).toBe('.')
    expect(result.include).toEqual(['src/**'])
    expect(result.exclude).toEqual([
      '**/package-lock.json',
      '**/yarn.lock',
      '**/pnpm-lock.yaml',
      '**/*.lock',
      '**/go.sum',
      '**/Cargo.lock',
    ])
    expect(result.maxFileBytes).toBe(200_000)
    expect(result.embedding.model).toBe('nomic-embed-text')
    expect(result.embedding.batchSize).toBe(48)
    expect(result.llm.model).toBe('qwen2.5-coder:14b')
    expect(result.llm.numCtx).toBe(32768)
    expect(result.llm.temperature).toBe(0.1)
    expect(result.llm.rewriteTemperature).toBe(0.3)
    expect(result.retrieval.kVector).toBe(20)
    expect(result.retrieval.kFts).toBe(20)
    expect(result.retrieval.kFinal).toBe(8)
    expect(result.retrieval.expandDepth).toBe(1)
    expect(result.retrieval.rewrite).toBe(false)
    expect(result.retrieval.rerank).toBe('false')
    expect(result.store.driver).toBe('lancedb')
    expect(result.store.path).toBe('.rag')
    expect(result.budget.contextFraction).toBe(0.60)
    expect(result.budget.historyFraction).toBe(0.20)
  })

  it('merges partial config with defaults correctly', () => {
    const result = RagConfigSchema.parse({
      root: '/custom/root',
      llm: { model: 'custom-model' },
    })
    expect(result.root).toBe('/custom/root')
    expect(result.llm.model).toBe('custom-model')
    expect(result.llm.numCtx).toBe(32768) // default not overridden
    expect(result.embedding.model).toBe('nomic-embed-text') // default
  })

  it('numCtx default is 32768 (critical requirement)', () => {
    const result = RagConfigSchema.parse({})
    expect(result.llm.numCtx).toBe(32768)
  })

  it('embedding.model default is nomic-embed-text', () => {
    const result = RagConfigSchema.parse({})
    expect(result.embedding.model).toBe('nomic-embed-text')
  })

  it('throws ZodError on invalid store.driver value', () => {
    expect(() => {
      RagConfigSchema.parse({
        store: { driver: 'invalid-driver' },
      })
    }).toThrow()
  })

  it('throws ZodError on invalid rerank enum value', () => {
    expect(() => {
      RagConfigSchema.parse({
        retrieval: { rerank: 'invalid-rerank' },
      })
    }).toThrow()
  })

  it('accepts valid store.driver values', () => {
    const lancedb = RagConfigSchema.parse({ store: { driver: 'lancedb' } })
    expect(lancedb.store.driver).toBe('lancedb')

    const sqlite = RagConfigSchema.parse({ store: { driver: 'sqlite' } })
    expect(sqlite.store.driver).toBe('sqlite')
  })

  it('accepts valid rerank enum values', () => {
    const off = RagConfigSchema.parse({ retrieval: { rerank: 'false' } })
    expect(off.retrieval.rerank).toBe('false')

    const llm = RagConfigSchema.parse({ retrieval: { rerank: 'llm' } })
    expect(llm.retrieval.rerank).toBe('llm')

    const crossEncoder = RagConfigSchema.parse({ retrieval: { rerank: 'cross-encoder' } })
    expect(crossEncoder.retrieval.rerank).toBe('cross-encoder')
  })

  it('allows override of boolean values', () => {
    const result = RagConfigSchema.parse({
      retrieval: { rewrite: true },
    })
    expect(result.retrieval.rewrite).toBe(true)
  })

  it('allows override of numeric values', () => {
    const result = RagConfigSchema.parse({
      llm: { temperature: 0.5, numCtx: 16384 },
      retrieval: { kVector: 30, kFts: 40 },
    })
    expect(result.llm.temperature).toBe(0.5)
    expect(result.llm.numCtx).toBe(16384)
    expect(result.retrieval.kVector).toBe(30)
    expect(result.retrieval.kFts).toBe(40)
  })

  it('allows override of array values', () => {
    const result = RagConfigSchema.parse({
      include: ['lib/**', 'app/**'],
      exclude: ['**/*.test.ts'],
    })
    expect(result.include).toEqual(['lib/**', 'app/**'])
    expect(result.exclude).toEqual(['**/*.test.ts'])
  })
})
