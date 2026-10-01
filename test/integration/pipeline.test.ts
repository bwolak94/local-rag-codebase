import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Mock OllamaEmbedder before any imports that transitively load it.
// Returns 768-dim zero vectors (nomic-embed-text dimensionality).
// ---------------------------------------------------------------------------
vi.mock('../../src/embedding/ollama.js', () => {
  const DIM = 768
  return {
    OllamaEmbedder: vi.fn().mockImplementation((model: string) => ({
      model,
      dim: DIM,
      embed: vi.fn().mockImplementation(async (texts: string[]) =>
        texts.map(() => Array.from({ length: DIM }, () => Math.random())),
      ),
    })),
  }
})

import { collectFiles } from '../../src/ingest/walker.js'
import { TreeSitterChunker } from '../../src/chunking/treesitter.js'
import { OllamaEmbedder } from '../../src/embedding/ollama.js'
import { LanceDBStore } from '../../src/store/lancedb.js'
import type { EmbeddedChunk } from '../../src/types/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// The project root is two levels up from test/integration/
const REPO_ROOT = resolve(__dirname, '../..')
// Relative pattern that collectFiles (which uses minimatch) will match
const FIXTURE_INCLUDE = ['test/fixtures/sample-repo/src/**']

const EXPECTED_PATHS = [
  'test/fixtures/sample-repo/src/billing/invoice.service.ts',
  'test/fixtures/sample-repo/src/billing/tax-calculator.ts',
  'test/fixtures/sample-repo/src/auth/token.service.ts',
]

// Minimum expected symbols across all three files:
// InvoiceService, issue, recalculate, generateId (private — may merge)
// TaxCalculator, calculate, addRate, listRegions
// TokenService, sign, verify, refresh
const MIN_EXPECTED_SYMBOLS = 7

let tmpDir: string

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'rag-pipeline-test-'))
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('ingest pipeline integration', () => {
  it('collectFiles returns all three fixture TypeScript files', async () => {
    const files = await collectFiles(REPO_ROOT, FIXTURE_INCLUDE, [], 200_000)
    const paths = files.map(f => f.path)

    for (const expected of EXPECTED_PATHS) {
      expect(paths).toContain(expected)
    }
    // Should not contain files from outside the fixture directory
    const nonFixture = paths.filter(p => !p.startsWith('test/fixtures/sample-repo/src/'))
    expect(nonFixture).toHaveLength(0)
  })

  it('TreeSitterChunker supports TypeScript files', () => {
    const chunker = new TreeSitterChunker()
    expect(
      chunker.supports({ path: 'foo.ts', lang: 'typescript', content: '', hash: '' }),
    ).toBe(true)
  })

  it('pipeline produces >= expected symbol count across fixture files', async () => {
    const files = await collectFiles(REPO_ROOT, FIXTURE_INCLUDE, [], 200_000)
    const chunker = new TreeSitterChunker()

    const allChunks: EmbeddedChunk[] = []
    const embedder = new OllamaEmbedder('nomic-embed-text')

    for (const file of files) {
      const chunks = await chunker.chunk(file)
      expect(chunks.length).toBeGreaterThan(0)

      const texts = chunks.map(c => c.header + '\n' + c.content)
      const vectors = await embedder.embed(texts, 'document')
      expect(vectors).toHaveLength(chunks.length)

      const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({
        ...c,
        vector: vectors[i]!,
      }))
      allChunks.push(...embedded)
    }

    expect(allChunks.length).toBeGreaterThanOrEqual(MIN_EXPECTED_SYMBOLS)
  })

  it('each chunk has a non-empty header containing file:, kind:, lang:typescript', async () => {
    const files = await collectFiles(REPO_ROOT, FIXTURE_INCLUDE, [], 200_000)
    const chunker = new TreeSitterChunker()

    for (const file of files) {
      const chunks = await chunker.chunk(file)
      for (const chunk of chunks) {
        expect(chunk.header).toBeTruthy()
        expect(chunk.header).toContain('file:')
        expect(chunk.header).toContain('kind:')
        expect(chunk.header).toContain('lang:typescript')
      }
    }
  })

  it('chunks can be upserted into LanceDBStore without errors', async () => {
    const files = await collectFiles(REPO_ROOT, FIXTURE_INCLUDE, [], 200_000)
    const chunker = new TreeSitterChunker()
    const embedder = new OllamaEmbedder('nomic-embed-text')
    const store = new LanceDBStore('.rag-test', tmpDir, 'nomic-embed-text')

    for (const file of files) {
      const chunks = await chunker.chunk(file)
      const texts = chunks.map(c => c.header + '\n' + c.content)
      const vectors = await embedder.embed(texts, 'document')
      const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({
        ...c,
        vector: vectors[i]!,
      }))
      await expect(store.upsert(embedded)).resolves.toBeUndefined()
    }

    const meta = await store.getMeta()
    expect(meta).not.toBeNull()
    expect(meta?.embedModel).toBe('nomic-embed-text')
    expect(meta?.dim).toBe(768)
  })
})
