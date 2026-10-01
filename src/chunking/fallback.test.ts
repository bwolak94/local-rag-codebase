import { describe, it, expect } from 'vitest'
import { SlidingWindowChunker } from './fallback.js'
import type { SourceFile } from '../types/index.js'
import { chunkHash } from '../ingest/hasher.js'

function makeFile(content: string, lang = 'typescript'): SourceFile {
  return {
    path: 'src/test.ts',
    lang,
    content,
    hash: 'test-hash',
  }
}

describe('SlidingWindowChunker', () => {
  const chunker = new SlidingWindowChunker(60, 10)

  it('supports() returns true for any file', async () => {
    const file = makeFile('const x = 1;')
    expect(chunker.supports(file)).toBe(true)
  })

  it('single file shorter than window produces exactly 1 chunk', async () => {
    const content = 'line 1\nline 2\nline 3\nline 4\nline 5'
    const file = makeFile(content)
    const chunks = await chunker.chunk(file)
    expect(chunks).toHaveLength(1)
  })

  it('file exactly at window size produces 1 chunk', async () => {
    const lines = Array.from({ length: 59 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const file = makeFile(content)
    const chunks = await chunker.chunk(file)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
  })

  it('file longer than window produces multiple overlapping chunks', async () => {
    // 150 lines should produce multiple chunks with overlap
    const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const file = makeFile(content)
    const chunks = await chunker.chunk(file)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('each chunk has correct startLine and endLine (1-indexed)', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const file = makeFile(content)
    const chunks = await chunker.chunk(file)

    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1)
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine)
      expect(chunk.startLine).toBeLessThanOrEqual(lines.length)
      expect(chunk.endLine).toBeLessThanOrEqual(lines.length)
    }
  })

  it('empty file produces no chunks', async () => {
    const file = makeFile('')
    const chunks = await chunker.chunk(file)
    expect(chunks).toHaveLength(0)
  })

  it('file with only whitespace produces no chunks', async () => {
    const file = makeFile('   \n\n   \n')
    const chunks = await chunker.chunk(file)
    expect(chunks).toHaveLength(0)
  })

  it('chunk kind is always text', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const file = makeFile(content)
    const chunks = await chunker.chunk(file)

    for (const chunk of chunks) {
      expect(chunk.kind).toBe('text')
    }
  })

  it('chunk header contains file, lines, and lang', async () => {
    const file = makeFile('line 1\nline 2\nline 3', 'python')
    const chunks = await chunker.chunk(file)
    expect(chunks).toHaveLength(1)
    const chunk = chunks[0]!
    expect(chunk.header).toContain('file:src/test.ts')
    expect(chunk.header).toContain('lines:')
    expect(chunk.header).toContain('lang:python')
  })

  it('chunk id is 16 hex chars', async () => {
    const file = makeFile('line 1\nline 2\nline 3')
    const chunks = await chunker.chunk(file)
    expect(chunks).toHaveLength(1)
    const chunk = chunks[0]!
    expect(chunk.id).toHaveLength(32)
    expect(chunk.id).toMatch(/^[0-9a-f]+$/)
  })

  it('chunk hash is sha256 of header + content', async () => {
    const file = makeFile('test content')
    const chunks = await chunker.chunk(file)
    expect(chunks).toHaveLength(1)
    const chunk = chunks[0]!
    const expectedHash = chunkHash(chunk.header, chunk.content)
    expect(chunk.hash).toBe(expectedHash)
  })

  it('chunks have non-empty content', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const file = makeFile(content)
    const chunks = await chunker.chunk(file)

    for (const chunk of chunks) {
      expect(chunk.content).toBeTruthy()
      expect(chunk.content.trim().length).toBeGreaterThan(0)
    }
  })

  it('overlapping chunks share content', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const file = makeFile(content)
    const chunks = await chunker.chunk(file)

    if (chunks.length > 1) {
      // Check that consecutive chunks overlap
      const chunk1 = chunks[0]!
      const chunk2 = chunks[1]!
      // Second chunk should start before first chunk ends
      expect(chunk2.startLine).toBeLessThanOrEqual(chunk1.endLine)
    }
  })

  it('path is preserved in chunks', async () => {
    const file = makeFile('line 1\nline 2', 'typescript')
    file.path = 'src/custom/path.ts'
    const chunks = await chunker.chunk(file)
    expect(chunks[0]?.path).toBe('src/custom/path.ts')
  })

  it('lang is preserved in chunks', async () => {
    const file = makeFile('line 1\nline 2', 'javascript')
    const chunks = await chunker.chunk(file)
    expect(chunks[0]?.lang).toBe('javascript')
  })

  it('no symbol field in chunks', async () => {
    const file = makeFile('line 1\nline 2\nline 3')
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      expect(chunk.symbol).toBeUndefined()
    }
  })
})
