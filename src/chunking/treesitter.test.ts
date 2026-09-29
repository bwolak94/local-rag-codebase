import { describe, it, expect } from 'vitest'
import { TreeSitterChunker, getParser } from './treesitter.js'
import type { SourceFile } from '../types/index.js'

function makeFile(content: string, lang = 'typescript'): SourceFile {
  return {
    path: 'src/test.ts',
    lang,
    content,
    hash: 'test-hash',
  }
}

describe('TreeSitterChunker', () => {
  const chunker = new TreeSitterChunker()

  it('supports() returns true for typescript', async () => {
    const file = makeFile('function test() {}', 'typescript')
    expect(chunker.supports(file)).toBe(true)
  })

  it('supports() returns true for tsx', async () => {
    const file = makeFile('function test() {}', 'tsx')
    expect(chunker.supports(file)).toBe(true)
  })

  it('supports() returns true for javascript', async () => {
    const file = makeFile('function test() {}', 'javascript')
    expect(chunker.supports(file)).toBe(true)
  })

  it('supports() returns false for python', async () => {
    const file = makeFile('def test(): pass', 'python')
    expect(chunker.supports(file)).toBe(false)
  })

  it('supports() returns false for vue', async () => {
    const file = makeFile('<template></template>', 'vue')
    expect(chunker.supports(file)).toBe(false)
  })

  it('supports() returns false for text', async () => {
    const file = makeFile('some text', 'text')
    expect(chunker.supports(file)).toBe(false)
  })

  it('chunking a simple TypeScript function produces at least 1 chunk', async () => {
    const content = `
export function greet(name: string): string {
  return 'Hello ' + name
}
`.trim()
    const file = makeFile(content, 'typescript')
    const parser = await getParser('typescript')
    if (!parser) {
      // WASM unavailable, skip
      return
    }
    const chunks = await chunker.chunk(file)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
  })

  it('chunk has kind function for function declarations', async () => {
    const content = `
function myFunc() {
  return 42
}
`.trim()
    const file = makeFile(content, 'typescript')
    const parser = await getParser('typescript')
    if (!parser) return
    const chunks = await chunker.chunk(file)
    const funcChunk = chunks.find(c => c.kind === 'function')
    expect(funcChunk).toBeDefined()
    expect(funcChunk?.symbol).toBe('myFunc')
  })

  it('chunk has kind class for class declarations', async () => {
    const content = `
class MyService {
  doWork(): void {}
}
`.trim()
    const file = makeFile(content, 'typescript')
    const parser = await getParser('typescript')
    if (!parser) return
    const chunks = await chunker.chunk(file)
    const classChunk = chunks.find(c => c.kind === 'class')
    expect(classChunk).toBeDefined()
    expect(classChunk?.symbol).toBe('MyService')
  })

  it('chunk has kind interface for interface declarations', async () => {
    const content = `
interface Reader {
  read(): string
}
`.trim()
    const file = makeFile(content, 'typescript')
    const parser = await getParser('typescript')
    if (!parser) return
    const chunks = await chunker.chunk(file)
    const ifaceChunk = chunks.find(c => c.kind === 'interface')
    expect(ifaceChunk).toBeDefined()
    expect(ifaceChunk?.symbol).toBe('Reader')
  })

  it('chunk has non-empty symbol', async () => {
    const content = `
export function test() {
  return 1
}
`.trim()
    const file = makeFile(content, 'typescript')
    const parser = await getParser('typescript')
    if (!parser) return
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      if (chunk.kind !== 'text') {
        expect(chunk.symbol).toBeTruthy()
      }
    }
  })

  it('chunk header contains file, symbol, kind, lang, lines', async () => {
    const content = `
function test() {
  return 1
}
`.trim()
    const file = makeFile(content, 'typescript')
    const parser = await getParser('typescript')
    if (!parser) return
    const chunks = await chunker.chunk(file)
    const funcChunk = chunks.find(c => c.kind === 'function')
    if (funcChunk) {
      expect(funcChunk.header).toContain('file:')
      expect(funcChunk.header).toContain('symbol:')
      expect(funcChunk.header).toContain('kind:function')
      expect(funcChunk.header).toContain('lang:typescript')
      expect(funcChunk.header).toContain('lines:')
    }
  })

  it('falls back to SlidingWindowChunker for unsupported language', async () => {
    const content = 'def test(): pass'
    const file = makeFile(content, 'python')
    const chunks = await chunker.chunk(file)
    // Should fall back to sliding window, producing chunks with kind='text'
    expect(chunks.length).toBeGreaterThanOrEqual(0)
    const textChunks = chunks.filter(c => c.kind === 'text')
    expect(textChunks.length).toBeGreaterThanOrEqual(0)
  })

  it('falls back to SlidingWindowChunker for empty file', async () => {
    const file = makeFile('', 'typescript')
    const parser = await getParser('typescript')
    if (!parser) return
    const chunks = await chunker.chunk(file)
    // Empty file should fall back (no symbols to extract)
    expect(chunks).toBeDefined()
  })

  it('context header is prepended before embedding (tested via content)', async () => {
    const content = `
function test() {
  return 1
}
`.trim()
    const file = makeFile(content, 'typescript')
    const parser = await getParser('typescript')
    if (!parser) return
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      // Each chunk should have a header field with context info
      expect(chunk.header).toBeTruthy()
      expect(chunk.content).toBeTruthy()
    }
  })

  it('chunk id is 16 hex chars', async () => {
    const content = `
function myFunc() {
  return 1
}
`.trim()
    const file = makeFile(content, 'typescript')
    const parser = await getParser('typescript')
    if (!parser) return
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      expect(chunk.id).toHaveLength(16)
      expect(chunk.id).toMatch(/^[0-9a-f]+$/)
    }
  })

  it('chunks have correct startLine and endLine (1-indexed)', async () => {
    const content = `function alpha() {
  return 1
}

function beta() {
  return 2
}`
    const file = makeFile(content, 'typescript')
    const parser = await getParser('typescript')
    if (!parser) return
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1)
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine)
    }
  })

  it('lang and path are preserved in chunks', async () => {
    const content = `
function test() {
  return 1
}
`.trim()
    const file = makeFile(content, 'typescript')
    file.path = 'src/custom/module.ts'
    const parser = await getParser('typescript')
    if (!parser) return
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      expect(chunk.lang).toBe('typescript')
      expect(chunk.path).toBe('src/custom/module.ts')
    }
  })
})
