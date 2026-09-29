import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SQLiteSymbolIndex } from './index.js'
import type { SymbolDef, SymbolRef } from '../types/index.js'

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

describe('SQLiteSymbolIndex', () => {
  let tmpDir: string
  let idx: SQLiteSymbolIndex

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sym-idx-test-'))
    idx = new SQLiteSymbolIndex('.sym', tmpDir)
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
})
