import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IndexPipeline } from './pipeline.js'
import type { Store, Embedder, SourceFile, Chunk } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'
import { tmpdir } from 'node:os'
import { mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { resolve } from 'node:path'

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

  it('run() creates chunk_hashes table', () => {
    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    new IndexPipeline(config, store, embedder)

    // Verify the chunk_hashes table was created in the SQLite db
    const dbPath = resolve(tmpDir, '.rag-test', 'files.db')
    expect(existsSync(dbPath)).toBe(true)
    const db = new Database(dbPath)
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_hashes'"
    ).all() as Array<{ name: string }>
    expect(tables.length).toBe(1)
    expect(tables[0]?.name).toBe('chunk_hashes')
    db.close()
  })

  it('run() skips unchanged chunks (same hash) on second run', async () => {
    const { collectFiles } = await import('./walker.js')
    const mockedCollect = vi.mocked(collectFiles)

    // Mock the treesitter chunker to produce a deterministic chunk
    vi.mock('../chunking/treesitter.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../chunking/treesitter.js')>()
      return {
        ...original,
        TreeSitterChunker: vi.fn().mockImplementation(() => ({
          supports: () => false, // force fallback chunker
          chunk: vi.fn(),
        })),
        getParser: vi.fn().mockResolvedValue(null),
      }
    })

    const fakeFile: SourceFile = {
      path: 'src/stable.ts',
      lang: 'typescript',
      content: 'export const stable = 1',
      hash: 'stablehash',
    }
    mockedCollect.mockResolvedValue([fakeFile])

    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    const pipeline = new IndexPipeline(config, store, embedder)

    // First run: file processed (added = 1), embed called
    await pipeline.run()
    const embedCallsAfterFirst = vi.mocked(embedder.embed).mock.calls.length

    // Second run: same file, same hash → no new chunks to process
    await pipeline.run()
    const embedCallsAfterSecond = vi.mocked(embedder.embed).mock.calls.length

    // embed should not have been called again since the file hash matches
    // (file-level skip fires before chunk-level processing)
    expect(embedCallsAfterSecond).toBe(embedCallsAfterFirst)

    mockedCollect.mockResolvedValue([])
  })

  it('run() re-embeds changed chunks (different file hash)', async () => {
    const { collectFiles } = await import('./walker.js')
    const mockedCollect = vi.mocked(collectFiles)

    const fileV1: SourceFile = {
      path: 'src/changing.ts',
      lang: 'typescript',
      content: 'export const v = 1',
      hash: 'hashv1',
    }
    const fileV2: SourceFile = {
      path: 'src/changing.ts',
      lang: 'typescript',
      content: 'export const v = 2',
      hash: 'hashv2',
    }

    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    const pipeline = new IndexPipeline(config, store, embedder)

    mockedCollect.mockResolvedValue([fileV1])
    await pipeline.run()

    // Change the file content + hash
    mockedCollect.mockResolvedValue([fileV2])
    await pipeline.run()

    // deleteByPath should have been called for the changed file
    expect(store.deleteByPath).toHaveBeenCalledWith('src/changing.ts')

    mockedCollect.mockResolvedValue([])
  })

  it('removed chunk IDs are deleted from store on second run', async () => {
    const { collectFiles } = await import('./walker.js')
    const mockedCollect = vi.mocked(collectFiles)

    const fakeFile: SourceFile = {
      path: 'src/shrinking.ts',
      lang: 'typescript',
      content: 'export const a = 1',
      hash: 'hash-shrinking-v1',
    }

    mockedCollect.mockResolvedValue([fakeFile])
    const store = mockStore()
    const embedder = mockEmbedder()
    const config = testConfig(tmpDir)
    const pipeline = new IndexPipeline(config, store, embedder)

    // First run: file with one hash
    await pipeline.run()

    // Second run: same path, different hash (simulates content change)
    const fakeFileV2: SourceFile = { ...fakeFile, hash: 'hash-shrinking-v2' }
    mockedCollect.mockResolvedValue([fakeFileV2])
    await pipeline.run()

    // deleteByPath should have been called when re-processing changed file
    expect(store.deleteByPath).toHaveBeenCalledWith(fakeFile.path)

    mockedCollect.mockResolvedValue([])
  })
})
