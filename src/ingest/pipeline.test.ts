import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IndexPipeline } from './pipeline.js'
import type { Store, Embedder, SourceFile } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'

// Mock the walker so tests do not require a real git repo
vi.mock('./walker.js', () => ({
  collectFiles: vi.fn().mockResolvedValue([] as SourceFile[]),
}))

// mock store
const mockStore = (): Store => ({
  upsert: vi.fn().mockResolvedValue(undefined),
  deleteByPath: vi.fn().mockResolvedValue(undefined),
  vectorSearch: vi.fn().mockResolvedValue([]),
  textSearch: vi.fn().mockResolvedValue([]),
  getMeta: vi.fn().mockResolvedValue(null),
  getByIds: vi.fn().mockResolvedValue([]),
})

// mock embedder
const mockEmbedder = (): Embedder => ({
  model: 'test',
  dim: 4,
  embed: vi.fn().mockImplementation((texts: string[]) =>
    Promise.resolve(texts.map(() => [0.1, 0.2, 0.3, 0.4]))
  ),
})

function testConfig(root: string): RagConfig {
  return {
    root,
    include: ['**/*.ts'],
    exclude: [],
    maxFileBytes: 200_000,
    embedding: { model: 'nomic-embed-text', batchSize: 48 },
    llm: { model: 'qwen2.5-coder:14b', numCtx: 32768, temperature: 0.1, rewriteTemperature: 0.3 },
    retrieval: { kVector: 20, kFts: 20, kFinal: 8, expandDepth: 1, rewrite: false, rerank: 'false' },
    store: { driver: 'lancedb', path: '.rag-test' },
    budget: { contextFraction: 0.6, historyFraction: 0.2 },
  }
}

describe('IndexPipeline', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-test-'))
  })

  it('constructs without error', () => {
    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    expect(() => new IndexPipeline(config, store, embedder)).not.toThrow()
  })

  it('run() returns stats object', async () => {
    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    const pipeline = new IndexPipeline(config, store, embedder)
    const result = await pipeline.run()
    expect(result).toMatchObject({
      scanned: expect.any(Number),
      changed: expect.any(Number),
      added: expect.any(Number),
      deleted: expect.any(Number),
      chunks: expect.any(Number),
      elapsed: expect.any(Number),
    })
  })

  it('run() with full=true clears previous file records', async () => {
    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    const pipeline = new IndexPipeline(config, store, embedder)

    // first run to populate some state
    await pipeline.run()
    // full rebuild should not throw
    const result = await pipeline.run({ full: true })
    expect(result.scanned).toBeGreaterThanOrEqual(0)
  })

  it('run() with opts.paths filters to specific files', async () => {
    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    const pipeline = new IndexPipeline(config, store, embedder)

    // run with empty paths list — nothing should be processed
    const result = await pipeline.run({ paths: [] })
    expect(result.added).toBe(0)
    expect(result.changed).toBe(0)
    expect(result.chunks).toBe(0)
  })

  it('run() skips unchanged files on second run', async () => {
    const { collectFiles } = await import('./walker.js')
    const mockedCollect = vi.mocked(collectFiles)

    const fakeFile: SourceFile = {
      path: 'src/fake.ts',
      lang: 'typescript',
      content: 'export const x = 1',
      hash: 'abc123',
    }
    mockedCollect.mockResolvedValue([fakeFile])

    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    const pipeline = new IndexPipeline(config, store, embedder)

    const first = await pipeline.run()
    const second = await pipeline.run()

    // after first run file is recorded; second run should have 0 changed/added
    expect(second.changed).toBe(0)
    expect(second.added).toBe(0)
    // scanned count should remain the same
    expect(second.scanned).toBe(first.scanned)

    // restore
    mockedCollect.mockResolvedValue([])
  })

  it('elapsed is a non-negative number', async () => {
    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    const pipeline = new IndexPipeline(config, store, embedder)
    const result = await pipeline.run()
    expect(result.elapsed).toBeGreaterThanOrEqual(0)
  })

  it('run() deletes chunks for removed files', async () => {
    const { collectFiles } = await import('./walker.js')
    const mockedCollect = vi.mocked(collectFiles)

    const fakeFile: SourceFile = {
      path: 'src/to-be-removed.ts',
      lang: 'typescript',
      content: 'export const gone = true',
      hash: 'deadbeef',
    }

    // First run: file is present → added === 1
    mockedCollect.mockResolvedValue([fakeFile])
    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    const pipeline = new IndexPipeline(config, store, embedder)
    const first = await pipeline.run()
    expect(first.added).toBe(1)

    // Second run: file has been removed → deleted === 1, deleteByPath called
    mockedCollect.mockResolvedValue([])
    const second = await pipeline.run()
    expect(second.deleted).toBe(1)
    expect(store.deleteByPath).toHaveBeenCalledWith(fakeFile.path)

    // restore
    mockedCollect.mockResolvedValue([])
  })
})
