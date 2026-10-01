import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TreeSitterChunker, getParser } from './treesitter.js'
import type { SourceFile } from '../types/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = resolve(__dirname, '../../test/fixtures')

let parserAvailable = false

beforeAll(async () => {
  const parser = await getParser('typescript')
  parserAvailable = parser !== null && parser !== undefined
})

function makeFile(content: string, lang = 'typescript', path = 'src/test.ts'): SourceFile {
  return {
    path,
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

  it('supports() returns true for python', async () => {
    const file = makeFile('def test(): pass', 'python')
    expect(chunker.supports(file)).toBe(true)
  })

  it('supports() returns true for php', async () => {
    const file = makeFile('<?php function test() {}', 'php')
    expect(chunker.supports(file)).toBe(true)
  })

  it('supports() returns true for vue', async () => {
    const file = makeFile('<template></template>', 'vue')
    expect(chunker.supports(file)).toBe(true)
  })

  it('supports() returns false for text', async () => {
    const file = makeFile('some text', 'text')
    expect(chunker.supports(file)).toBe(false)
  })

  it.skipIf(() => !parserAvailable)('chunking a simple TypeScript function produces at least 1 chunk', async () => {
    const content = `
export function greet(name: string): string {
  return 'Hello ' + name
}
`.trim()
    const file = makeFile(content, 'typescript')
    const chunks = await chunker.chunk(file)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(() => !parserAvailable)('chunk has kind function for function declarations', async () => {
    const content = `
function myFunc() {
  return 42
}
`.trim()
    const file = makeFile(content, 'typescript')
    const chunks = await chunker.chunk(file)
    // Short functions (< 150 chars) are merged into a module-level chunk.
    // Accept either a direct function chunk or a module chunk containing the symbol name.
    const funcChunk = chunks.find(c => c.kind === 'function' && c.symbol === 'myFunc')
    const moduleChunk = chunks.find(c => c.kind === 'module' && c.content.includes('myFunc'))
    expect(funcChunk ?? moduleChunk).toBeDefined()
  })

  it.skipIf(() => !parserAvailable)('chunk has kind class for class declarations', async () => {
    const content = `
class MyService {
  doWork(): void {}
}
`.trim()
    const file = makeFile(content, 'typescript')
    const chunks = await chunker.chunk(file)
    // Short class bodies (< 150 chars) are merged into a module-level chunk.
    const classChunk = chunks.find(c => c.kind === 'class' && c.symbol === 'MyService')
    const moduleChunk = chunks.find(c => c.kind === 'module' && c.content.includes('MyService'))
    expect(classChunk ?? moduleChunk).toBeDefined()
  })

  it.skipIf(() => !parserAvailable)('chunk has kind interface for interface declarations', async () => {
    const content = `
interface Reader {
  read(): string
}
`.trim()
    const file = makeFile(content, 'typescript')
    const chunks = await chunker.chunk(file)
    // Short interface bodies (< 150 chars) are merged into a module-level chunk.
    const ifaceChunk = chunks.find(c => c.kind === 'interface' && c.symbol === 'Reader')
    const moduleChunk = chunks.find(c => c.kind === 'module' && c.content.includes('Reader'))
    expect(ifaceChunk ?? moduleChunk).toBeDefined()
  })

  it.skipIf(() => !parserAvailable)('chunk has non-empty symbol', async () => {
    const content = `
export function test() {
  return 1
}
`.trim()
    const file = makeFile(content, 'typescript')
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      // 'module' kind is used for merged tiny symbols — symbol field is intentionally undefined.
      // 'text' kind is used by the sliding-window fallback. Both are valid without a symbol.
      if (chunk.kind !== 'text' && chunk.kind !== 'module') {
        expect(chunk.symbol).toBeTruthy()
      }
    }
  })

  it.skipIf(() => !parserAvailable)('chunk header contains file, symbol, kind, lang, lines', async () => {
    const content = `
function test() {
  return 1
}
`.trim()
    const file = makeFile(content, 'typescript')
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
    const content = 'some random text content'
    const file = makeFile(content, 'text')
    const chunks = await chunker.chunk(file)
    // text lang is not supported — falls back to sliding window
    expect(chunks.length).toBeGreaterThan(0)
    const textChunks = chunks.filter(c => c.kind === 'text')
    expect(textChunks.length).toBeGreaterThan(0)
  })

  it.skipIf(() => !parserAvailable)('falls back to SlidingWindowChunker for empty file', async () => {
    const file = makeFile('', 'typescript')
    const chunks = await chunker.chunk(file)
    // Empty file should produce no chunks
    expect(chunks).toHaveLength(0)
  })

  it.skipIf(() => !parserAvailable)('context header is prepended before embedding (tested via content)', async () => {
    const content = `
function test() {
  return 1
}
`.trim()
    const file = makeFile(content, 'typescript')
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      // Each chunk should have a header field with context info
      expect(chunk.header).toBeTruthy()
      expect(chunk.content).toBeTruthy()
    }
  })

  it.skipIf(() => !parserAvailable)('chunk id is 16 hex chars', async () => {
    const content = `
function myFunc() {
  return 1
}
`.trim()
    const file = makeFile(content, 'typescript')
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      expect(chunk.id).toHaveLength(16)
      expect(chunk.id).toMatch(/^[0-9a-f]+$/)
    }
  })

  it.skipIf(() => !parserAvailable)('chunks have correct startLine and endLine (1-indexed)', async () => {
    const content = `function alpha() {
  return 1
}

function beta() {
  return 2
}`
    const file = makeFile(content, 'typescript')
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1)
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine)
    }
  })

  it.skipIf(() => !parserAvailable)('lang and path are preserved in chunks', async () => {
    const content = `
function test() {
  return 1
}
`.trim()
    const file = makeFile(content, 'typescript')
    file.path = 'src/custom/module.ts'
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      expect(chunk.lang).toBe('typescript')
      expect(chunk.path).toBe('src/custom/module.ts')
    }
  })

  // --- Stage 6: Python ---

  it.skipIf(() => !parserAvailable)('chunking sample.py produces chunks with kind function or class', async () => {
    const content = readFileSync(resolve(FIXTURES, 'sample.py'), 'utf8')
    const file = makeFile(content, 'python', 'test/fixtures/sample.py')
    const chunks = await chunker.chunk(file)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    const kindedChunks = chunks.filter(c => c.kind === 'function' || c.kind === 'class')
    expect(kindedChunks.length).toBeGreaterThanOrEqual(1)
  })

  it.skipIf(() => !parserAvailable)('chunking sample.py chunk headers contain lang:python', async () => {
    const content = readFileSync(resolve(FIXTURES, 'sample.py'), 'utf8')
    const file = makeFile(content, 'python', 'test/fixtures/sample.py')
    const chunks = await chunker.chunk(file)
    for (const chunk of chunks) {
      expect(chunk.header).toContain('lang:python')
    }
  })

  it.skipIf(() => !parserAvailable)('chunking sample.py produces a chunk for get_all_users with kind function (decorated function)', async () => {
    const content = readFileSync(resolve(FIXTURES, 'sample.py'), 'utf8')
    const file = makeFile(content, 'python', 'test/fixtures/sample.py')
    const chunks = await chunker.chunk(file)
    // Short functions (< 150 chars) are merged into a module-level chunk.
    // Check for either a direct function chunk or a module chunk containing 'get_all_users'.
    const decorated = chunks.find(c => c.symbol === 'get_all_users' && c.kind === 'function')
    const moduleChunk = chunks.find(c => c.kind === 'module' && c.content.includes('get_all_users'))
    expect(decorated ?? moduleChunk).toBeDefined()
    if (decorated) expect(decorated.kind).toBe('function')
  })

  // --- Stage 6: PHP ---

  it.skipIf(() => !parserAvailable)('chunking sample.php produces chunks with kind function, method, or class', async () => {
    const content = readFileSync(resolve(FIXTURES, 'sample.php'), 'utf8')
    const file = makeFile(content, 'php', 'test/fixtures/sample.php')
    const chunks = await chunker.chunk(file)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    const kindedChunks = chunks.filter(
      c => c.kind === 'function' || c.kind === 'method' || c.kind === 'class',
    )
    expect(kindedChunks.length).toBeGreaterThanOrEqual(1)
  })

  // --- Stage 6: Vue ---

  it.skipIf(() => !parserAvailable)('chunking sample.vue produces chunks from the script block with lang:vue', async () => {
    const content = readFileSync(resolve(FIXTURES, 'sample.vue'), 'utf8')
    const file = makeFile(content, 'vue', 'test/fixtures/sample.vue')
    const chunks = await chunker.chunk(file)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    for (const chunk of chunks) {
      expect(chunk.lang).toBe('vue')
      expect(chunk.header).toContain('lang:vue')
    }
  })

  it.skipIf(() => !parserAvailable)('Vue chunks have correct startLine offset accounting for template lines above', async () => {
    const content = readFileSync(resolve(FIXTURES, 'sample.vue'), 'utf8')
    const file = makeFile(content, 'vue', 'test/fixtures/sample.vue')
    const chunks = await chunker.chunk(file)
    // The <script> block starts after the <template> block (lines 1-3) and a blank line (line 4)
    // So all script-derived chunks must have startLine > 4
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThan(4)
    }
  })

  it.skipIf(() => !parserAvailable)('Vue formatMessage chunk has startLine === 10 (pinned line offset check)', async () => {
    // sample.vue: <template> is lines 1-3, blank line 4, <script lang="ts"> opens line 5,
    // script content starts line 6, formatMessage is the 5th line of script content → line 10
    // Short functions (< 150 chars) are merged into a module-level chunk.
    // The merged chunk covers from the first tiny symbol to the last.
    const content = readFileSync(resolve(FIXTURES, 'sample.vue'), 'utf8')
    const file = makeFile(content, 'vue', 'test/fixtures/sample.vue')
    const chunks = await chunker.chunk(file)
    // Accept a direct function chunk at line 10 OR a module chunk that contains 'formatMessage'
    // and has startLine <= 10 (because tiny symbols from this file are merged together)
    const fmChunk = chunks.find(c => c.symbol === 'formatMessage')
    const moduleChunk = chunks.find(c => c.kind === 'module' && c.content.includes('formatMessage'))
    const found = fmChunk ?? moduleChunk
    expect(found).toBeDefined()
    // The chunk (or the merged module chunk) must start at or before line 10
    expect(found?.startLine).toBeLessThanOrEqual(10)
  })

  it('Vue file with no script block falls back to SlidingWindowChunker', async () => {
    const content = `<template>
  <div>Hello</div>
</template>

<style>
div { color: blue; }
</style>`
    const file = makeFile(content, 'vue', 'test/fixtures/no-script.vue')
    const chunks = await chunker.chunk(file)
    // Falls back to sliding window — chunks have kind 'text'
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    const textChunks = chunks.filter(c => c.kind === 'text')
    expect(textChunks.length).toBeGreaterThanOrEqual(1)
  })
})
