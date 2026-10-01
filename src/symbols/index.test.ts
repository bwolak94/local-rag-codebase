import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SQLiteSymbolIndex } from './index.js'
import type { SymbolDef, SymbolRef } from '../types/index.js'

let sqliteAvailable = false
try {
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  db.close()
  sqliteAvailable = true
} catch { /* native binding not available — all tests will be skipped */ }

function makeDef(overrides: Partial<SymbolDef> = {}): SymbolDef {
  return {
    name: 'myFn',
    kind: 'function',
    path: 'src/a.ts',
    startLine: 1,
    endLine: 10,
    chunkId: 'chunk001',
    ...overrides,
  }
}

function makeRef(overrides: Partial<SymbolRef> = {}): SymbolRef {
  return {
    name: 'myFn',
    path: 'src/b.ts',
    line: 5,
    chunkId: 'chunk002',
    ...overrides,
  }
}

describe.skipIf(!sqliteAvailable)('SQLiteSymbolIndex', () => {
  let tmpDir: string
  let idx: SQLiteSymbolIndex

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sym-idx-test-'))
    idx = new SQLiteSymbolIndex('.sym', tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('upsert() inserts defs and refs without error', async () => {
    await expect(idx.upsert([makeDef()], [makeRef()])).resolves.toBeUndefined()
  })

  it('definitions() returns correct records by name', async () => {
    const def = makeDef({ name: 'MyClass', kind: 'class', startLine: 20, endLine: 50, chunkId: 'cABC' })
    await idx.upsert([def], [])
    const results = await idx.definitions('MyClass')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ name: 'MyClass', kind: 'class', startLine: 20, endLine: 50 })
  })

  it('definitions() returns empty array when name not found', async () => {
    const results = await idx.definitions('nonExistent')
    expect(results).toEqual([])
  })

  it('references() returns correct records by name', async () => {
    const ref = makeRef({ name: 'helperFn', path: 'src/c.ts', line: 42, chunkId: 'cDEF' })
    await idx.upsert([], [ref])
    const results = await idx.references('helperFn')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ name: 'helperFn', path: 'src/c.ts', line: 42 })
  })

  it('references() returns empty array when name not found', async () => {
    const results = await idx.references('unknown')
    expect(results).toEqual([])
  })

  it('deleteByPath() removes all defs and refs for that path', async () => {
    const def = makeDef({ path: 'src/del.ts', chunkId: 'cDEL1' })
    const ref = makeRef({ path: 'src/del.ts', chunkId: 'cDEL2' })
    const otherDef = makeDef({ name: 'other', path: 'src/keep.ts', startLine: 99, chunkId: 'cKEEP' })
    await idx.upsert([def, otherDef], [ref])

    await idx.deleteByPath('src/del.ts')

    const defs = await idx.definitions('myFn')
    // only the 'keep' file's entry should remain (but it has name 'other')
    expect(defs.filter(d => d.path === 'src/del.ts')).toHaveLength(0)

    const refs = await idx.references('myFn')
    expect(refs.filter(r => r.path === 'src/del.ts')).toHaveLength(0)

    // the other path is untouched
    const kept = await idx.definitions('other')
    expect(kept).toHaveLength(1)
  })

  it('neighbors() returns chunkIds of chunks that reference symbols defined in the seed chunk', async () => {
    // seed chunk defines 'process'
    const def = makeDef({ name: 'process', chunkId: 'seed-chunk', startLine: 1 })
    // another chunk references 'process'
    const ref = makeRef({ name: 'process', chunkId: 'ref-chunk', path: 'src/consumer.ts', line: 10 })
    await idx.upsert([def], [ref])

    const result = await idx.neighbors('seed-chunk')
    expect(result).toContain('ref-chunk')
    expect(result).not.toContain('seed-chunk')
  })

  it('neighbors() returns empty array when no refs exist for defined symbols', async () => {
    const def = makeDef({ name: 'isolated', chunkId: 'alone-chunk', startLine: 1 })
    await idx.upsert([def], [])
    const result = await idx.neighbors('alone-chunk')
    expect(result).toEqual([])
  })

  it('neighbors() with depth=2 follows two hops', async () => {
    // Hop 0 → seed defines 'alpha'
    const def1 = makeDef({ name: 'alpha', chunkId: 'chunk-A', path: 'src/a.ts', startLine: 1 })
    // Hop 1 → chunk-B references 'alpha' and defines 'beta'
    const ref1 = makeRef({ name: 'alpha', chunkId: 'chunk-B', path: 'src/b.ts', line: 5 })
    const def2 = makeDef({ name: 'beta', chunkId: 'chunk-B', path: 'src/b.ts', startLine: 5 })
    // Hop 2 → chunk-C references 'beta'
    const ref2 = makeRef({ name: 'beta', chunkId: 'chunk-C', path: 'src/c.ts', line: 8 })

    await idx.upsert([def1, def2], [ref1, ref2])

    const depth1 = await idx.neighbors('chunk-A', 1)
    expect(depth1).toContain('chunk-B')
    expect(depth1).not.toContain('chunk-C')

    const depth2 = await idx.neighbors('chunk-A', 2)
    expect(depth2).toContain('chunk-B')
    expect(depth2).toContain('chunk-C')
    expect(depth2).not.toContain('chunk-A')
  })

  it('upsert() called twice for same path does not duplicate refs', async () => {
    const def = makeDef({ path: 'src/a.ts', chunkId: 'chunk1', name: 'foo' })
    const ref = makeRef({ path: 'src/b.ts', chunkId: 'chunk2', name: 'foo' })

    // First upsert
    await idx.upsert([def], [ref])

    // Second upsert for same path (should use UNIQUE constraint to ignore duplicates)
    await idx.upsert([def], [ref])

    const refs = await idx.references('foo')
    // Should have exactly 1 ref, not 2
    expect(refs.filter(r => r.path === 'src/b.ts')).toHaveLength(1)
  })

  it('neighbors() returns empty array when no symbols defined in seed chunk', async () => {
    // Seed chunk has no definitions
    const result = await idx.neighbors('empty-chunk')
    expect(result).toEqual([])
  })

  it('neighbors() with depth=0 returns empty array', async () => {
    const def = makeDef({ chunkId: 'chunk-A' })
    const ref = makeRef({ chunkId: 'chunk-B', name: 'myFn' })
    await idx.upsert([def], [ref])

    const result = await idx.neighbors('chunk-A', 0)
    expect(result).toEqual([])
  })

  it('definitions() with different symbol names return correct defs', async () => {
    const fnDef = makeDef({ name: 'processData', kind: 'function', chunkId: 'c1', path: 'src/a.ts' })
    const classDef = makeDef({ name: 'Builder', kind: 'class', chunkId: 'c2', path: 'src/b.ts' })
    await idx.upsert([fnDef, classDef], [])

    const fnDefs = await idx.definitions('processData')
    expect(fnDefs.length).toBeGreaterThanOrEqual(1)
    expect(fnDefs[0]?.name).toBe('processData')

    const classDefs = await idx.definitions('Builder')
    expect(classDefs.length).toBeGreaterThanOrEqual(1)
    expect(classDefs[0]?.name).toBe('Builder')
  })

  it('multiple refs to same symbol in different chunks are all stored', async () => {
    const def = makeDef({ name: 'shared' })
    const ref1 = makeRef({ name: 'shared', chunkId: 'chunk-user-1', path: 'src/a.ts', line: 5 })
    const ref2 = makeRef({ name: 'shared', chunkId: 'chunk-user-2', path: 'src/b.ts', line: 10 })
    await idx.upsert([def], [ref1, ref2])

    const refs = await idx.references('shared')
    expect(refs.length).toBeGreaterThanOrEqual(1)
    const chunkIds = refs.map(r => r.chunkId)
    expect(chunkIds).toContain('chunk-user-1')
    expect(chunkIds).toContain('chunk-user-2')
  })

  it('deleteByPath() is atomic and removes both defs and refs', async () => {
    const def = makeDef({ path: 'src/delete.ts', chunkId: 'c1', name: 'foo' })
    const ref = makeRef({ path: 'src/delete.ts', chunkId: 'c2', name: 'foo' })
    const otherRef = makeRef({ path: 'src/keep.ts', chunkId: 'c3', name: 'foo' })
    await idx.upsert([def], [ref, otherRef])

    await idx.deleteByPath('src/delete.ts')

    const defs = await idx.definitions('foo')
    expect(defs).toHaveLength(0)

    const refs = await idx.references('foo')
    expect(refs).toHaveLength(1)
    expect(refs[0]?.path).toBe('src/keep.ts')
  })
})
