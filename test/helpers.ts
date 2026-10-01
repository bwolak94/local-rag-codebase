import type { RagConfig } from '../src/config/schema.js'

export function makeTestConfig(overrides: Partial<RagConfig> = {}): RagConfig {
  const base: RagConfig = {
    root: '.',
    include: ['src/**'],
    exclude: [],
    maxFileBytes: 200_000,
    embedding: { model: 'nomic-embed-text', batchSize: 48, host: 'http://localhost:11434' },
    llm: {
      model: 'qwen2.5-coder:14b',
      host: 'http://localhost:11434',
      numCtx: 32768,
      temperature: 0.1,
      rewriteTemperature: 0.3,
    },
    retrieval: {
      kVector: 20,
      kFts: 20,
      kFinal: 8,
      rrfK: 60,
      expandDepth: 1,
      rewrite: false,
      rerank: 'none',
      hydeTemperature: 0.0,
    },
    store: { driver: 'lancedb', path: '.rag' },
    budget: { contextFraction: 0.6, historyFraction: 0.2 },
  }

  return {
    ...base,
    ...overrides,
    embedding: { ...base.embedding, ...overrides.embedding },
    llm: { ...base.llm, ...overrides.llm },
    retrieval: { ...base.retrieval, ...overrides.retrieval },
    store: { ...base.store, ...overrides.store },
    budget: { ...base.budget, ...overrides.budget },
  }
}
