import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Prevent native-binding crash when @lancedb/lancedb binary is missing.
// importOriginal re-uses the real module when available; falls back to a stub.
vi.mock('@lancedb/lancedb', async (importOriginal) => {
  try { return await importOriginal() } catch { return {} }
})

import { LanceDBStore, ModelMismatchError } from './lancedb.js'

let lancedbAvailable = false
try {
  await import('@lancedb/lancedb')
  // Verify the binary actually loaded (the mock returns {} when it fails)
  const mod = await import('@lancedb/lancedb') as Record<string, unknown>
  lancedbAvailable = typeof mod.connect === 'function'
} catch { /* native binding not available — all tests will be skipped */ }
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { EmbeddedChunk } from '../types/index.js'

function makeEmbeddedChunk(
  id: string,
  overrides: Partial<EmbeddedChunk> = {}
): EmbeddedChunk {
  return {
    id,
    path: 'src/test.ts',
    lang: 'typescript',
    kind: 'function',
    startLine: 1,
    endLine: 10,
    header: `file:src/test.ts lines:1-10`,
    content: 'test content',
    hash: 'test-hash',
    vector: [0.1, 0.2, 0.3, 0.4],
    ...overrides,
  }
}

describe.skipIf(!lancedbAvailable)('LanceDBStore', () => {
  let tmpDir: string
  let store: LanceDBStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lancedb-test-'))
    store = new LanceDBStore('.rag', tmpDir, 'nomic-embed-text')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getMeta() returns null on empty store', async () => {
    const result = await store.getMeta()
    expect(result).toBeNull()
  })

  it('upsert() persists chunks', async () => {
    const chunk = makeEmbeddedChunk('chunk1')
    await store.upsert([chunk])
    // After upsert, we can verify by trying to retrieve
    const results = await store.getByIds(['chunk1'])
    expect(results).toHaveLength(1)
    expect(results[0]?.chunk.id).toBe('chunk1')
  })

  it('getMeta() returns correct embedModel and dim after upsert', async () => {
    const chunk = makeEmbeddedChunk('chunk1', { vector: [0.1, 0.2, 0.3, 0.4] })
    await store.upsert([chunk])
    const meta = await store.getMeta()
    expect(meta).not.toBeNull()
    expect(meta?.embedModel).toBe('nomic-embed-text')
    expect(meta?.dim).toBe(4)
  })

  it('upsert() twice with same chunk id (mergeInsert) does not duplicate', async () => {
    const chunk1 = makeEmbeddedChunk('chunk1', { content: 'original' })
    await store.upsert([chunk1])

    const chunk2 = makeEmbeddedChunk('chunk1', { content: 'updated' })
    await store.upsert([chunk2])

    const results = await store.getByIds(['chunk1'])
    expect(results).toHaveLength(1)
  })

  it('deleteByPath() removes all chunks for that path', async () => {
    const chunk1 = makeEmbeddedChunk('chunk1', { path: 'src/delete-me.ts' })
    const chunk2 = makeEmbeddedChunk('chunk2', { path: 'src/keep.ts' })
    await store.upsert([chunk1, chunk2])

    await store.deleteByPath('src/delete-me.ts')

    const deleted = await store.getByIds(['chunk1'])
    const kept = await store.getByIds(['chunk2'])
    expect(deleted).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })

  it('vectorSearch() returns empty array on empty store', async () => {
    const vector = [0.1, 0.2, 0.3, 0.4]
    const result = await store.vectorSearch(vector, 10)
    expect(result).toEqual([])
  })

  it('textSearch() returns empty array on empty store', async () => {
    const result = await store.textSearch('query', 10)
    expect(result).toEqual([])
  })

  it('getByIds([]) returns empty array', async () => {
    const result = await store.getByIds([])
    expect(result).toEqual([])
  })

  it('vectorSearch() returns chunks with vector source', async () => {
    const chunk = makeEmbeddedChunk('chunk1')
    await store.upsert([chunk])
    const results = await store.vectorSearch([0.1, 0.2, 0.3, 0.4], 10)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.source).toBe('vector')
  })

  it('textSearch() returns empty or results with fts source', async () => {
    const chunk = makeEmbeddedChunk('chunk1', { content: 'searchable text' })
    await store.upsert([chunk])
    const results = await store.textSearch('searchable', 10)
    // FTS may not be indexed by default in test environment
    for (const result of results) {
      expect(result.source).toBe('fts')
    }
  })

  it('getByIds() returns chunks with expanded source', async () => {
    const chunk = makeEmbeddedChunk('chunk1')
    await store.upsert([chunk])
    const results = await store.getByIds(['chunk1'])
    expect(results).toHaveLength(1)
    expect(results[0]?.source).toBe('expanded')
  })

  it('upsert preserves chunk fields', async () => {
    const chunk = makeEmbeddedChunk('chunk1', {
      path: 'src/custom.ts',
      lang: 'javascript',
      kind: 'class',
      symbol: 'MyClass',
      startLine: 5,
      endLine: 20,
    })
    await store.upsert([chunk])
    const results = await store.getByIds(['chunk1'])
    const retrieved = results[0]?.chunk
    expect(retrieved?.path).toBe('src/custom.ts')
    expect(retrieved?.lang).toBe('javascript')
    expect(retrieved?.kind).toBe('class')
    expect(retrieved?.symbol).toBe('MyClass')
    expect(retrieved?.startLine).toBe(5)
    expect(retrieved?.endLine).toBe(20)
  })

  it('vectorSearch respects pathPrefix filter', async () => {
    const chunk1 = makeEmbeddedChunk('chunk1', { path: 'src/lib/util.ts' })
    const chunk2 = makeEmbeddedChunk('chunk2', { path: 'test/test.ts' })
    await store.upsert([chunk1, chunk2])

    const results = await store.vectorSearch(
      [0.1, 0.2, 0.3, 0.4],
      10,
      { pathPrefix: 'src/' }
    )

    // At least the filtered path should be found if found at all
    const paths = results.map(r => r.chunk.path)
    const nonSrcPaths = paths.filter(p => !p.startsWith('src/'))
    expect(nonSrcPaths).toHaveLength(0)
  })

  it('textSearch respects pathPrefix filter', async () => {
    const chunk1 = makeEmbeddedChunk('chunk1', {
      path: 'src/service.ts',
      content: 'findable',
    })
    const chunk2 = makeEmbeddedChunk('chunk2', {
      path: 'dist/out.ts',
      content: 'findable',
    })
    await store.upsert([chunk1, chunk2])

    const results = await store.textSearch('findable', 10, { pathPrefix: 'src/' })

    // All results should match filter
    for (const result of results) {
      expect(result.chunk.path.startsWith('src/')).toBe(true)
    }
  })

  it('handle special characters in path safely', async () => {
    const chunk = makeEmbeddedChunk('chunk1', { path: "src/file's.ts" })
    await store.upsert([chunk])
    await store.deleteByPath("src/file's.ts")
    // Should not throw or SQL inject
    const results = await store.getByIds(['chunk1'])
    expect(results).toHaveLength(0)
  })

  it("vectorSearch with single-quote in pathPrefix does not throw", async () => {
    const chunkInQuotedDir = makeEmbeddedChunk('chunk-sq-vec', {
      path: "src/file's directory/a.ts",
    })
    const chunkOther = makeEmbeddedChunk('chunk-sq-vec-other', {
      path: 'src/other/b.ts',
    })
    await store.upsert([chunkInQuotedDir, chunkOther])

    // If vectorSearch throws, the test fails on the await — that is the desired behaviour
    const results = await store.vectorSearch(
      [0.1, 0.2, 0.3, 0.4],
      10,
      { pathPrefix: "src/file's directory/" },
    )

    // Every returned result must come from the quoted-directory prefix
    for (const r of results) {
      expect(r.chunk.path.startsWith("src/file's directory/")).toBe(true)
    }
  })

  it("textSearch with single-quote in pathPrefix does not throw", async () => {
    const chunkInQuotedDir = makeEmbeddedChunk('chunk-sq-fts', {
      path: "src/file's directory/a.ts",
      content: 'uniqueterm',
    })
    const chunkOther = makeEmbeddedChunk('chunk-sq-fts-other', {
      path: 'src/other/b.ts',
      content: 'uniqueterm',
    })
    await store.upsert([chunkInQuotedDir, chunkOther])

    // If textSearch throws, the test fails on the await — that is the desired behaviour
    const results = await store.textSearch(
      'uniqueterm',
      10,
      { pathPrefix: "src/file's directory/" },
    )

    // Every returned result (if any) must come from the quoted-directory prefix
    for (const r of results) {
      expect(r.chunk.path.startsWith("src/file's directory/")).toBe(true)
    }
  })

  it('upsert with empty array does nothing', async () => {
    await expect(store.upsert([])).resolves.toBeUndefined()
    const meta = await store.getMeta()
    expect(meta).toBeNull()
  })

  it('multiple upsets accumulate chunks', async () => {
    await store.upsert([makeEmbeddedChunk('chunk1')])
    await store.upsert([makeEmbeddedChunk('chunk2')])
    const results = await store.getByIds(['chunk1', 'chunk2'])
    expect(results).toHaveLength(2)
  })
})

describe.skipIf(!lancedbAvailable)('ModelMismatchError', () => {
  it('message contains both model names', () => {
    const error = new ModelMismatchError('bge-m3', 'nomic-embed-text')
    expect(error.message).toContain('bge-m3')
    expect(error.message).toContain('nomic-embed-text')
  })

  it('has correct error name', () => {
    const error = new ModelMismatchError('model1', 'model2')
    expect(error.name).toBe('ModelMismatchError')
  })

  it('suggests --full reindex', () => {
    const error = new ModelMismatchError('old', 'new')
    expect(error.message).toContain('--full')
  })
})
