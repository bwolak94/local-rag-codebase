import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SQLiteStore } from './sqlite.js'
import { ModelMismatchError } from './errors.js'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { EmbeddedChunk } from '../types/index.js'

function makeChunk(id: string, overrides: Partial<EmbeddedChunk> = {}): EmbeddedChunk {
  return {
    id,
    path: 'src/test.ts',
    lang: 'typescript',
    kind: 'function',
    startLine: 1,
    endLine: 10,
    header: 'file:src/test.ts lines:1-10',
    content: 'test content',
    hash: 'test-hash',
    vector: [0.1, 0.2, 0.3, 0.4],
    ...overrides,
  }
}

describe('SQLiteStore', () => {
  let tmpDir: string
  let store: SQLiteStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sqlite-test-'))
    store = new SQLiteStore('.rag', tmpDir, 'nomic-embed-text')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getMeta() returns null on empty store', async () => {
    expect(await store.getMeta()).toBeNull()
  })

  it('upsert() stores chunks and getMeta() returns correct model/dim', async () => {
    await store.upsert([makeChunk('c1', { vector: [0.1, 0.2, 0.3, 0.4] })])
    const meta = await store.getMeta()
    expect(meta).not.toBeNull()
    expect(meta?.embedModel).toBe('nomic-embed-text')
    expect(meta?.dim).toBe(4)
  })

  it('upsert() with empty array does nothing', async () => {
    await expect(store.upsert([])).resolves.toBeUndefined()
    expect(await store.getMeta()).toBeNull()
  })

  it('upsert() twice with same id replaces the chunk', async () => {
    await store.upsert([makeChunk('c1', { content: 'original' })])
    await store.upsert([makeChunk('c1', { content: 'updated' })])
    const results = await store.getByIds(['c1'])
    expect(results).toHaveLength(1)
    expect(results[0]?.chunk.content).toBe('updated')
  })

  it('vectorSearch() returns closest chunk first with deterministic vectors', async () => {
    const near = makeChunk('near', { vector: [1.0, 0.0, 0.0, 0.0] })
    const far = makeChunk('far', { vector: [0.0, 0.0, 0.0, 1.0] })
    await store.upsert([near, far])
    const results = await store.vectorSearch([1.0, 0.0, 0.0, 0.0], 2)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.chunk.id).toBe('near')
    expect(results[0]?.source).toBe('vector')
  })

  it('vectorSearch() returns empty array on empty store', async () => {
    expect(await store.vectorSearch([0.1, 0.2, 0.3, 0.4], 5)).toEqual([])
  })

  it('vectorSearch() respects pathPrefix filter', async () => {
    await store.upsert([
      makeChunk('c1', { path: 'src/lib/a.ts', vector: [1, 0, 0, 0] }),
      makeChunk('c2', { path: 'test/b.ts', vector: [1, 0, 0, 0] }),
    ])
    const results = await store.vectorSearch([1, 0, 0, 0], 10, { pathPrefix: 'src/' })
    expect(results.every(r => r.chunk.path.startsWith('src/'))).toBe(true)
  })

  it('textSearch() returns chunk containing the search term', async () => {
    await store.upsert([
      makeChunk('c1', { content: 'invoiceService processes payments' }),
      makeChunk('c2', { content: 'unrelated code here' }),
    ])
    const results = await store.textSearch('invoiceService', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.chunk.id).toBe('c1')
    expect(results[0]?.source).toBe('fts')
  })

  it('textSearch() returns empty array on empty store', async () => {
    expect(await store.textSearch('anything', 5)).toEqual([])
  })

  it('textSearch() score is positive (negated FTS5 rank)', async () => {
    await store.upsert([makeChunk('c1', { content: 'unique term here' })])
    const results = await store.textSearch('unique', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.score).toBeGreaterThan(0)
  })

  it('textSearch() respects pathPrefix filter', async () => {
    await store.upsert([
      makeChunk('c1', { path: 'src/a.ts', content: 'findable code' }),
      makeChunk('c2', { path: 'dist/b.ts', content: 'findable code' }),
    ])
    const results = await store.textSearch('findable', 10, { pathPrefix: 'src/' })
    expect(results.every(r => r.chunk.path.startsWith('src/'))).toBe(true)
  })

  it('deleteByPath() removes all chunks for that path', async () => {
    await store.upsert([
      makeChunk('c1', { path: 'src/remove.ts' }),
      makeChunk('c2', { path: 'src/keep.ts' }),
    ])
    await store.deleteByPath('src/remove.ts')
    expect(await store.getByIds(['c1'])).toHaveLength(0)
    expect(await store.getByIds(['c2'])).toHaveLength(1)
  })

  it('deleteByPath() also removes from FTS and vec tables', async () => {
    await store.upsert([makeChunk('c1', { path: 'src/gone.ts', content: 'goneterm' })])
    await store.deleteByPath('src/gone.ts')
    const fts = await store.textSearch('goneterm', 5)
    expect(fts).toHaveLength(0)
    const vec = await store.vectorSearch([0.1, 0.2, 0.3, 0.4], 5)
    expect(vec.every(r => r.chunk.path !== 'src/gone.ts')).toBe(true)
  })

  it('getByIds() returns correct chunks with source: expanded', async () => {
    await store.upsert([makeChunk('c1'), makeChunk('c2')])
    const results = await store.getByIds(['c1', 'c2'])
    expect(results).toHaveLength(2)
    expect(results.every(r => r.source === 'expanded')).toBe(true)
    expect(results.every(r => r.score === 1)).toBe(true)
  })

  it('getByIds([]) returns empty array', async () => {
    expect(await store.getByIds([])).toEqual([])
  })

  it('getByIds() preserves all chunk fields', async () => {
    const chunk = makeChunk('c1', {
      path: 'src/custom.ts',
      lang: 'javascript',
      kind: 'class',
      symbol: 'MyClass',
      startLine: 5,
      endLine: 20,
    })
    await store.upsert([chunk])
    const results = await store.getByIds(['c1'])
    const r = results[0]?.chunk
    expect(r?.path).toBe('src/custom.ts')
    expect(r?.lang).toBe('javascript')
    expect(r?.kind).toBe('class')
    expect(r?.symbol).toBe('MyClass')
    expect(r?.startLine).toBe(5)
    expect(r?.endLine).toBe(20)
  })

  it('vectorSearch() score is in (0,1] — higher is better', async () => {
    await store.upsert([makeChunk('c1', { vector: [1, 0, 0, 0] })])
    const results = await store.vectorSearch([1, 0, 0, 0], 1)
    expect(results[0]?.score).toBeGreaterThan(0)
    expect(results[0]?.score).toBeLessThanOrEqual(1)
  })

  it('vectorSearch() respects lang filter', async () => {
    await store.upsert([
      makeChunk('c1', { lang: 'typescript', vector: [1, 0, 0, 0] }),
      makeChunk('c2', { lang: 'python', vector: [1, 0, 0, 0] }),
    ])
    const results = await store.vectorSearch([1, 0, 0, 0], 10, { lang: ['typescript'] })
    expect(results.every(r => r.chunk.lang === 'typescript')).toBe(true)
    expect(results.some(r => r.chunk.id === 'c1')).toBe(true)
  })

  it('vectorSearch() respects kind filter', async () => {
    await store.upsert([
      makeChunk('c1', { kind: 'class', vector: [1, 0, 0, 0] }),
      makeChunk('c2', { kind: 'function', vector: [1, 0, 0, 0] }),
    ])
    const results = await store.vectorSearch([1, 0, 0, 0], 10, { kind: ['class'] })
    expect(results.every(r => r.chunk.kind === 'class')).toBe(true)
  })

  it('textSearch() respects lang filter', async () => {
    await store.upsert([
      makeChunk('c1', { lang: 'typescript', content: 'searchable term' }),
      makeChunk('c2', { lang: 'python', content: 'searchable term' }),
    ])
    const results = await store.textSearch('searchable', 10, { lang: ['typescript'] })
    expect(results.every(r => r.chunk.lang === 'typescript')).toBe(true)
  })

  it('ModelMismatchError thrown when upserting with a different embedModel', async () => {
    await store.upsert([makeChunk('c1')])
    const store2 = new SQLiteStore('.rag', tmpDir, 'bge-m3')
    await expect(store2.upsert([makeChunk('c2')])).rejects.toThrow(ModelMismatchError)
  })
})
