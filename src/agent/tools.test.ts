import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  semanticSearch, grep, readFile, findSymbol, getReferences, listDir,
  type ToolContext,
} from './tools.js'
import type { ScoredChunk, Retriever, SymbolIndex, SymbolDef, SymbolRef } from '../types/index.js'

// Mock child_process.spawnSync for grep tests
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}))

import { spawnSync } from 'node:child_process'
const mockSpawnSync = vi.mocked(spawnSync)

function makeChunk(id: string, path = 'src/a.ts', symbol?: string): ScoredChunk {
  return {
    chunk: {
      id,
      path,
      lang: 'typescript',
      kind: 'function',
      symbol,
      startLine: 10,
      endLine: 20,
      header: '',
      content: `function ${id}() {}`,
      hash: '',
    },
    score: 0.9876,
    source: 'fused',
  }
}

function mockRetriever(results: ScoredChunk[]): Retriever {
  return {
    retrieve: vi.fn().mockResolvedValue(results),
  }
}

function mockSymbolIndex(): SymbolIndex {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    deleteByPath: vi.fn().mockResolvedValue(undefined),
    definitions: vi.fn().mockResolvedValue([]),
    references: vi.fn().mockResolvedValue([]),
    neighbors: vi.fn().mockResolvedValue([]),
  }
}

function makeCtx(retriever: Retriever, symbolIndex: SymbolIndex, root: string): ToolContext {
  return { retriever, symbolIndex, root }
}

// ── semanticSearch ─────────────────────────────────────────────────────────

describe('semanticSearch', () => {
  it('formats results as [path:start-end (symbol)] score=...', async () => {
    const chunk = makeChunk('myFn', 'src/a.ts', 'myFn')
    const ctx = makeCtx(mockRetriever([chunk]), mockSymbolIndex(), '/root')
    const result = await semanticSearch({ query: 'my function', k: 8 }, ctx)
    expect(result).toContain('[src/a.ts:10-20 (myFn)] score=0.9876')
    expect(result).toContain('function myFn() {}')
  })

  it('formats results without symbol when symbol is undefined', async () => {
    const chunk = makeChunk('noSym', 'src/b.ts', undefined)
    const ctx = makeCtx(mockRetriever([chunk]), mockSymbolIndex(), '/root')
    const result = await semanticSearch({ query: 'test', k: 8 }, ctx)
    expect(result).toContain('[src/b.ts:10-20] score=0.9876')
    expect(result).not.toContain('(undefined)')
  })

  it('returns "No results found." when store is empty', async () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), '/root')
    const result = await semanticSearch({ query: 'anything', k: 8 }, ctx)
    expect(result).toBe('No results found.')
  })

  it('passes pathPrefix filter when path option is provided', async () => {
    const retriever = mockRetriever([])
    const ctx = makeCtx(retriever, mockSymbolIndex(), '/root')
    await semanticSearch({ query: 'test', k: 5, path: 'src/utils' }, ctx)
    expect(retriever.retrieve).toHaveBeenCalledWith('test', {
      k: 5,
      filter: { pathPrefix: 'src/utils' },
    })
  })

  it('separates multiple results with ---', async () => {
    const chunk1 = makeChunk('fn1', 'src/a.ts')
    const chunk2 = makeChunk('fn2', 'src/b.ts')
    const ctx = makeCtx(mockRetriever([chunk1, chunk2]), mockSymbolIndex(), '/root')
    const result = await semanticSearch({ query: 'test', k: 8 }, ctx)
    expect(result).toContain('---')
  })
})

// ── grep ───────────────────────────────────────────────────────────────────

describe('grep', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset()
  })

  it('returns "No matches found." when exit code is 1 (no matches)', async () => {
    mockSpawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '', pid: 1, output: [], signal: null })

    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), '/root')
    const result = await grep({ pattern: 'noMatch' }, ctx)
    expect(result).toBe('No matches found.')
  })

  it('returns grep output when matches exist', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: 'src/a.ts:10:function foo() {}', stderr: '', pid: 1, output: [], signal: null })

    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), '/root')
    const result = await grep({ pattern: 'foo' }, ctx)
    expect(result).toBe('src/a.ts:10:function foo() {}')
  })

  it('returns "No matches found." when output is empty string', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null })

    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), '/root')
    const result = await grep({ pattern: 'foo' }, ctx)
    expect(result).toBe('No matches found.')
  })

  it('returns error message for non-zero, non-1 exit codes', async () => {
    mockSpawnSync.mockReturnValue({ status: 127, stdout: '', stderr: 'git not found', pid: 1, output: [], signal: null })

    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), '/root')
    const result = await grep({ pattern: 'foo' }, ctx)
    expect(result).toContain('grep error:')
  })

  it('returns error when spawnSync returns an error object', async () => {
    mockSpawnSync.mockReturnValue({ status: null, stdout: '', stderr: '', error: new Error('ENOENT'), pid: 1, output: [], signal: null })

    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), '/root')
    const result = await grep({ pattern: 'foo' }, ctx)
    expect(result).toContain('grep error:')
  })

  it('rejects path traversal outside root', async () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), '/tmp/abc')
    const result = await grep({ pattern: 'foo', path: '../../../etc' }, ctx)
    expect(result).toContain('Error: path outside repository root')
  })
})

// ── readFile ───────────────────────────────────────────────────────────────

describe('readFile', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = resolve(tmpdir(), `rag-tools-test-${Date.now()}`)
    mkdirSync(tmpRoot, { recursive: true })
    writeFileSync(resolve(tmpRoot, 'test.ts'), 'line1\nline2\nline3\nline4\nline5\n')
  })

  it('reads the entire file when no start/end given', () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), tmpRoot)
    const result = readFile({ path: 'test.ts' }, ctx)
    expect(result).toContain('line1')
    expect(result).toContain('line5')
  })

  it('returns correct line range (1-indexed)', () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), tmpRoot)
    const result = readFile({ path: 'test.ts', start: 2, end: 4 }, ctx)
    expect(result).toBe('line2\nline3\nline4')
  })

  it('returns correct single line when start === end', () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), tmpRoot)
    const result = readFile({ path: 'test.ts', start: 3, end: 3 }, ctx)
    expect(result).toBe('line3')
  })

  it('returns error message for path traversal attempt', () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), tmpRoot)
    const result = readFile({ path: '../../../etc/passwd' }, ctx)
    expect(result).toContain('Error: path outside repository root')
  })

  it('rejects adjacent directory that shares root prefix but is not under root', () => {
    // if root is /tmp/abc, /tmp/abcdef/secret must be rejected
    const fakeRoot = '/tmp/abc'
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), fakeRoot)
    // resolve('/tmp/abc', '../abcdef/secret') => '/tmp/abcdef/secret'
    // which starts with '/tmp/abc' string but is NOT under '/tmp/abc/'
    const result = readFile({ path: '../abcdef/secret' }, ctx)
    expect(result).toContain('Error: path outside repository root')
  })

  it('returns error for non-existent file', () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), tmpRoot)
    const result = readFile({ path: 'does-not-exist.ts' }, ctx)
    expect(result).toContain('Error: cannot read')
  })
})

// ── findSymbol ─────────────────────────────────────────────────────────────

describe('findSymbol', () => {
  it('returns formatted definitions', async () => {
    const symbolIndex = mockSymbolIndex()
    const defs: SymbolDef[] = [
      { name: 'MyClass', kind: 'class', path: 'src/my.ts', startLine: 5, endLine: 50, chunkId: 'c1' },
    ]
    vi.mocked(symbolIndex.definitions).mockResolvedValue(defs)

    const ctx = makeCtx(mockRetriever([]), symbolIndex, '/root')
    const result = await findSymbol({ name: 'MyClass' }, ctx)
    expect(result).toBe('src/my.ts:5-50 [class]')
  })

  it('returns "No definitions found" message when empty', async () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), '/root')
    const result = await findSymbol({ name: 'Unknown' }, ctx)
    expect(result).toContain("No definitions found for 'Unknown'")
  })

  it('formats multiple definitions one per line', async () => {
    const symbolIndex = mockSymbolIndex()
    const defs: SymbolDef[] = [
      { name: 'fn', kind: 'function', path: 'src/a.ts', startLine: 1, endLine: 5, chunkId: 'c1' },
      { name: 'fn', kind: 'function', path: 'src/b.ts', startLine: 10, endLine: 15, chunkId: 'c2' },
    ]
    vi.mocked(symbolIndex.definitions).mockResolvedValue(defs)

    const ctx = makeCtx(mockRetriever([]), symbolIndex, '/root')
    const result = await findSymbol({ name: 'fn' }, ctx)
    const lines = result.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('src/a.ts')
    expect(lines[1]).toContain('src/b.ts')
  })
})

// ── getReferences ──────────────────────────────────────────────────────────

describe('getReferences', () => {
  it('returns formatted references', async () => {
    const symbolIndex = mockSymbolIndex()
    const refs: SymbolRef[] = [
      { name: 'myFn', path: 'src/caller.ts', line: 42, chunkId: 'c1' },
    ]
    vi.mocked(symbolIndex.references).mockResolvedValue(refs)

    const ctx = makeCtx(mockRetriever([]), symbolIndex, '/root')
    const result = await getReferences({ symbol: 'myFn' }, ctx)
    expect(result).toBe('src/caller.ts:42')
  })

  it('returns "No references found" when empty', async () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), '/root')
    const result = await getReferences({ symbol: 'ghost' }, ctx)
    expect(result).toContain("No references found for 'ghost'")
  })

  it('formats multiple references one per line', async () => {
    const symbolIndex = mockSymbolIndex()
    const refs: SymbolRef[] = [
      { name: 'fn', path: 'src/a.ts', line: 1, chunkId: 'c1' },
      { name: 'fn', path: 'src/b.ts', line: 99, chunkId: 'c2' },
    ]
    vi.mocked(symbolIndex.references).mockResolvedValue(refs)

    const ctx = makeCtx(mockRetriever([]), symbolIndex, '/root')
    const result = await getReferences({ symbol: 'fn' }, ctx)
    const lines = result.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('src/a.ts:1')
    expect(lines[1]).toBe('src/b.ts:99')
  })
})

// ── listDir ────────────────────────────────────────────────────────────────

describe('listDir', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = resolve(tmpdir(), `rag-listdir-test-${Date.now()}`)
    mkdirSync(resolve(tmpRoot, 'subdir'), { recursive: true })
    writeFileSync(resolve(tmpRoot, 'file.ts'), 'hello')
  })

  it('lists files with sizes and directories with trailing /', () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), tmpRoot)
    const result = listDir({ path: '.' }, ctx)
    expect(result).toContain('subdir/')
    expect(result).toMatch(/file\.ts \(\d+B\)/)
  })

  it('returns error for path traversal attempt', () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), tmpRoot)
    const result = listDir({ path: '../../../etc' }, ctx)
    expect(result).toContain('Error: path outside repository root')
  })

  it('rejects adjacent directory that shares root prefix but is not under root', () => {
    // e.g. root=/tmp/abc, path ../abcdef resolves to /tmp/abcdef — starts with /tmp/abc but not under it
    const fakeRoot = '/tmp/abc'
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), fakeRoot)
    const result = listDir({ path: '../abcdef' }, ctx)
    expect(result).toContain('Error: path outside repository root')
  })

  it('returns error for non-existent directory', () => {
    const ctx = makeCtx(mockRetriever([]), mockSymbolIndex(), tmpRoot)
    const result = listDir({ path: 'nonexistent' }, ctx)
    expect(result).toContain('Error: cannot list')
  })
})
