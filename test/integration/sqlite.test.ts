import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Check whether the better-sqlite3 native binding is available in this
// environment before importing anything that transitively loads it.
// ---------------------------------------------------------------------------
let sqliteAvailable = false
try {
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  db.close()
  sqliteAvailable = true
} catch {
  /* native binding not available — all tests in this file will be skipped */
}

// ---------------------------------------------------------------------------
// Mock OllamaEmbedder — must be declared before any import of the module.
// All inputs receive the same deterministic 4-dimensional vector so that
// vector-search ranking is fully controlled by the stored chunk vectors.
// ---------------------------------------------------------------------------
vi.mock('../../src/embedding/ollama.js', () => {
  const DIM = 4

  function makeVec(base: number): number[] {
    return [base, base * 0.9, base * 0.8, base * 0.7]
  }

  return {
    OllamaEmbedder: vi.fn().mockImplementation((model: string) => ({
      model,
      dim: DIM,
      embed: vi.fn().mockImplementation(async (texts: string[]) =>
        texts.map(t => {
          const lower = t.toLowerCase()
          if (lower.includes('invoice')) return makeVec(0.95)
          if (lower.includes('tax')) return makeVec(0.85)
          return makeVec(0.1)
        }),
      ),
    })),
  }
})

import { SQLiteStore } from '../../src/store/sqlite.js'
import { SQLiteSymbolIndex } from '../../src/symbols/index.js'
import { HybridRetriever } from '../../src/retrieval/hybrid.js'
import { OllamaEmbedder } from '../../src/embedding/ollama.js'
import { IndexPipeline } from '../../src/ingest/pipeline.js'
import { RagConfigSchema } from '../../src/config/schema.js'
import type { EmbeddedChunk, SymbolDef, SymbolRef } from '../../src/types/index.js'

// ---------------------------------------------------------------------------
// Helpers — mirrors the exact pattern from retrieval.test.ts
// ---------------------------------------------------------------------------

const DIM = 4

function makeVec(base: number): number[] {
  return [base, base * 0.9, base * 0.8, base * 0.7]
}

function makeChunk(
  id: string,
  path: string,
  symbol: string,
  content: string,
  vectorBase: number,
  startLine = 1,
  endLine = 10,
): EmbeddedChunk {
  const header = `file:${path} symbol:${symbol} kind:class lang:typescript lines:${startLine}-${endLine}`
  return {
    id,
    path,
    lang: 'typescript',
    kind: 'class',
    symbol,
    startLine,
    endLine,
    header,
    content,
    hash: id + '-hash',
    vector: makeVec(vectorBase),
  }
}

// ---------------------------------------------------------------------------
// Fixture chunks — each domain gets a strictly distinct vector base so that
// L2 nearest-neighbour ranking is fully deterministic.
// ---------------------------------------------------------------------------

const INVOICE_CHUNK = makeChunk(
  'sqlite-invoice-001',
  'src/billing/invoice.service.ts',
  'InvoiceService',
  `export class InvoiceService {
  constructor(private taxCalculator: TaxCalculator) {}
  issue(customerId: string, region: string): Invoice {
    return { id: customerId, region }
  }
}`,
  0.95, // strictly highest billing base — always closest to "invoice" query
  1,
  8,
)

const TAX_CHUNK = makeChunk(
  'sqlite-tax-001',
  'src/billing/tax-calculator.ts',
  'TaxCalculator',
  `export class TaxCalculator {
  calculate(amount: number, region: string): TaxResult {
    const rate = this.rates.get(region) ?? 0.2
    return { base: amount, tax: amount * rate, total: amount * (1 + rate), region }
  }
}`,
  0.85, // lower than invoice — second closest to "invoice" query
  1,
  7,
)

const TOKEN_CHUNK = makeChunk(
  'sqlite-token-001',
  'src/auth/token.service.ts',
  'TokenService',
  `export class TokenService {
  sign(payload: TokenPayload): SignedToken {
    return { token: 'signed', expiresAt: new Date() }
  }
}`,
  0.1, // far from billing — never surfaces in billing queries
  1,
  6,
)

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))
// The project root is two levels up from test/integration/
const REPO_ROOT = resolve(__dirname, '../..')

describe.skipIf(!sqliteAvailable)('SQLiteStore end-to-end', () => {
  // -------------------------------------------------------------------------
  // Test 1: upsert and direct vectorSearch / textSearch
  // -------------------------------------------------------------------------
  describe('indexes files and retrieves chunks via hybrid search', () => {
    let tmpDir: string
    let store: SQLiteStore

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'rag-sqlite-search-test-'))
      store = new SQLiteStore('.rag-test', tmpDir, 'nomic-embed-text')
      await store.upsert([INVOICE_CHUNK, TAX_CHUNK, TOKEN_CHUNK])
    })

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    it('getMeta returns the correct embedModel and dim after upsert', async () => {
      const meta = await store.getMeta()
      expect(meta).not.toBeNull()
      expect(meta?.embedModel).toBe('nomic-embed-text')
      expect(meta?.dim).toBe(DIM)
    })

    it('vectorSearch for "invoice" returns billing/invoice.service.ts as top result', async () => {
      // Query vector matching "invoice" (base 0.95) should be closest to INVOICE_CHUNK
      const qVec = makeVec(0.95)
      const results = await store.vectorSearch(qVec, 5)

      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.chunk.path).toBe('src/billing/invoice.service.ts')
      expect(results[0]!.source).toBe('vector')
    })

    it('vectorSearch returns all three chunks when k is large enough', async () => {
      const qVec = makeVec(0.5)
      const results = await store.vectorSearch(qVec, 10)

      expect(results.length).toBe(3)
      const paths = results.map(r => r.chunk.path)
      expect(paths).toContain('src/billing/invoice.service.ts')
      expect(paths).toContain('src/billing/tax-calculator.ts')
      expect(paths).toContain('src/auth/token.service.ts')
    })

    it('textSearch for "TaxCalculator" returns tax-calculator.ts chunk', async () => {
      const results = await store.textSearch('TaxCalculator', 5)

      expect(results.length).toBeGreaterThan(0)
      const paths = results.map(r => r.chunk.path)
      expect(paths).toContain('src/billing/tax-calculator.ts')
      expect(results[0]!.source).toBe('fts')
    })

    it('textSearch for "InvoiceService" returns invoice.service.ts chunk', async () => {
      const results = await store.textSearch('InvoiceService', 5)

      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.chunk.path).toBe('src/billing/invoice.service.ts')
    })

    it('vectorSearch with pathPrefix filter excludes auth/token.service.ts', async () => {
      const qVec = makeVec(0.9)
      const results = await store.vectorSearch(qVec, 10, { pathPrefix: 'src/billing' })

      const authPaths = results.filter(r => r.chunk.path.startsWith('src/auth/'))
      expect(authPaths).toHaveLength(0)
      expect(results.length).toBe(2)
    })

    it('textSearch with pathPrefix filter excludes auth/token.service.ts', async () => {
      // "class" appears in every chunk — billing prefix should exclude auth
      const results = await store.textSearch('class', 10, { pathPrefix: 'src/billing' })

      const authPaths = results.filter(r => r.chunk.path.startsWith('src/auth/'))
      expect(authPaths).toHaveLength(0)
    })

    it('getByIds returns the exact requested chunks with source=expanded', async () => {
      const results = await store.getByIds([INVOICE_CHUNK.id, TOKEN_CHUNK.id])

      expect(results).toHaveLength(2)
      const ids = results.map(r => r.chunk.id)
      expect(ids).toContain(INVOICE_CHUNK.id)
      expect(ids).toContain(TOKEN_CHUNK.id)
      expect(results[0]!.source).toBe('expanded')
    })

    it('getByIds with empty array returns empty array', async () => {
      const results = await store.getByIds([])
      expect(results).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Test 2: HybridRetriever.retrieve() using SQLite backend
  // -------------------------------------------------------------------------
  describe('HybridRetriever.retrieve() returns results using SQLite backend', () => {
    let tmpDir: string
    let store: SQLiteStore
    let symbolIndex: SQLiteSymbolIndex

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'rag-sqlite-retriever-test-'))

      store = new SQLiteStore('.rag-test', tmpDir, 'nomic-embed-text')
      await store.upsert([INVOICE_CHUNK, TAX_CHUNK, TOKEN_CHUNK])

      symbolIndex = new SQLiteSymbolIndex('.rag-test', tmpDir)

      // Seed symbol index: InvoiceService references TaxCalculator (cross-chunk edge)
      const defs: SymbolDef[] = [
        {
          name: 'InvoiceService',
          kind: 'class',
          path: 'src/billing/invoice.service.ts',
          startLine: 1,
          endLine: 8,
          chunkId: INVOICE_CHUNK.id,
        },
        {
          name: 'TaxCalculator',
          kind: 'class',
          path: 'src/billing/tax-calculator.ts',
          startLine: 1,
          endLine: 7,
          chunkId: TAX_CHUNK.id,
        },
        {
          name: 'TokenService',
          kind: 'class',
          path: 'src/auth/token.service.ts',
          startLine: 1,
          endLine: 6,
          chunkId: TOKEN_CHUNK.id,
        },
      ]
      const refs: SymbolRef[] = [
        // invoice.service references TaxCalculator (type ref + call)
        {
          name: 'TaxCalculator',
          path: 'src/billing/invoice.service.ts',
          line: 2,
          chunkId: INVOICE_CHUNK.id,
        },
      ]
      await symbolIndex.upsert(defs, refs)
    })

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    it('retrieve() returns results for a billing query', async () => {
      const embedder = new OllamaEmbedder('nomic-embed-text')
      const retriever = new HybridRetriever(store, embedder, {
        kVector: 10,
        kFts: 10,
        symbolIndex,
      })

      const results = await retriever.retrieve('invoice service billing', { k: 5 })

      expect(results.length).toBeGreaterThan(0)
    })

    it('retrieve() with pathPrefix filter restricts to billing files', async () => {
      const embedder = new OllamaEmbedder('nomic-embed-text')
      const retriever = new HybridRetriever(store, embedder, {
        kVector: 10,
        kFts: 10,
        symbolIndex,
      })

      const results = await retriever.retrieve('invoice service', {
        k: 5,
        filter: { pathPrefix: 'src/billing' },
      })

      expect(results.length).toBeGreaterThan(0)
      for (const r of results) {
        expect(r.chunk.path).not.toContain('src/auth/')
      }
    })

    it('retrieve() returns invoice.service.ts as top result for "invoice" query', async () => {
      const embedder = new OllamaEmbedder('nomic-embed-text')
      const retriever = new HybridRetriever(store, embedder, {
        kVector: 10,
        kFts: 10,
        symbolIndex,
      })

      const results = await retriever.retrieve('invoice issue customer', { k: 3 })

      expect(results.length).toBeGreaterThan(0)
      // The RRF-fused top result must be the invoice chunk — it has the highest
      // vector similarity (base 0.95) AND textSearch hit on "invoice"
      expect(results[0]!.chunk.path).toBe('src/billing/invoice.service.ts')
    })

    it('retrieve() with expand:true includes TaxCalculator as neighbor of InvoiceService', async () => {
      const embedder = new OllamaEmbedder('nomic-embed-text')
      const retriever = new HybridRetriever(store, embedder, {
        kVector: 10,
        kFts: 10,
        symbolIndex,
        expandMaxTokens: 8192,
        expandDepth: 1,
      })

      const results = await retriever.retrieve('invoice issue', {
        k: 3,
        expand: true,
      })

      // With expansion, TaxCalculator must appear because InvoiceService has a
      // ref to TaxCalculator seeded in the symbol graph.
      const paths = results.map(r => r.chunk.path)
      const hasTax = paths.some(p => p.includes('tax-calculator'))
      expect(hasTax).toBe(true)
    })

    it('symbolIndex.neighbors for InvoiceService returns TaxCalculator chunk', async () => {
      const neighborIds = await symbolIndex.neighbors(INVOICE_CHUNK.id, 1)
      expect(neighborIds).toContain(TAX_CHUNK.id)
    })

    it('symbolIndex.definitions for TaxCalculator returns correct def', async () => {
      const defs = await symbolIndex.definitions('TaxCalculator')
      expect(defs.length).toBeGreaterThan(0)
      expect(defs[0]!.path).toBe('src/billing/tax-calculator.ts')
      expect(defs[0]!.kind).toBe('class')
    })
  })

  // -------------------------------------------------------------------------
  // Test 3: incremental reindex skips unchanged files (IndexPipeline)
  // The pipeline uses collectFiles which lists git-tracked files.
  // We point it at the repo root with a narrow fixture include pattern so it
  // only processes the three pre-existing fixture TypeScript files.
  // -------------------------------------------------------------------------
  describe('incremental reindex skips unchanged files', () => {
    let tmpDir: string
    let pipeline: IndexPipeline

    beforeAll(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'rag-sqlite-pipeline-test-'))

      const config = RagConfigSchema.parse({
        root: REPO_ROOT,
        include: ['test/fixtures/sample-repo/src/**'],
        exclude: [],
        store: { driver: 'sqlite', path: tmpDir },
        embedding: { model: 'nomic-embed-text', batchSize: 48 },
      })

      const store = new SQLiteStore(tmpDir, REPO_ROOT, 'nomic-embed-text')
      const embedder = new OllamaEmbedder('nomic-embed-text')

      pipeline = new IndexPipeline(config, store, embedder)
    })

    afterAll(async () => {
      await rm(tmpDir, { recursive: true, force: true })
    })

    it('first run adds fixture files and produces chunks', async () => {
      const result = await pipeline.run()

      // The fixture directory contains 3 TypeScript source files
      expect(result.scanned).toBeGreaterThanOrEqual(3)
      expect(result.added).toBeGreaterThanOrEqual(3)
      expect(result.changed).toBe(0)
      expect(result.chunks).toBeGreaterThan(0)
    })

    it('second run with no file changes reports zero added/changed/chunks', async () => {
      const result = await pipeline.run()

      expect(result.added).toBe(0)
      expect(result.changed).toBe(0)
      // No new chunks are upserted when every file hash matches its record
      expect(result.chunks).toBe(0)
    })
  })
})
