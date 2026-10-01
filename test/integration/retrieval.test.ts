import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mock OllamaEmbedder — must be declared before any import of the module.
// Query vectors are billingHigh (0.95) for "invoice", billingLow (0.85) for
// "tax", and authLow (0.1) otherwise — ensuring deterministic L2 ranking.
// ---------------------------------------------------------------------------
vi.mock('../../src/embedding/ollama.js', () => {
  const DIM = 768

  function makeVec(base: number): number[] {
    return Array.from({ length: DIM }, (_, i) => (i === 0 ? base : base * 0.99))
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

import { LanceDBStore } from '../../src/store/lancedb.js'
import { SQLiteSymbolIndex } from '../../src/symbols/index.js'
import { HybridRetriever } from '../../src/retrieval/hybrid.js'
import { OllamaEmbedder } from '../../src/embedding/ollama.js'
import type { EmbeddedChunk, SymbolDef, SymbolRef } from '../../src/types/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DIM = 768

function makeVec(base: number): number[] {
  return Array.from({ length: DIM }, (_, i) => (i === 0 ? base : base * 0.99))
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
// Fixture data — each domain gets a strictly distinct vector base
// so L2 nearest-neighbor ranking is fully deterministic.
// ---------------------------------------------------------------------------

const INVOICE_CHUNK = makeChunk(
  'invoice-chunk-001',
  'src/billing/invoice.service.ts',
  'InvoiceService',
  `export class InvoiceService {
  constructor(private taxCalculator: TaxCalculator) {}
  issue(customerId: string, region: string, lineItems: LineItem[]): Invoice {
    const subtotal = lineItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0)
    const taxResult = this.taxCalculator.calculate(subtotal, region)
    return { id: this.generateId(), customerId, region, subtotal, tax: taxResult.tax, total: taxResult.total, issuedAt: new Date() }
  }
}`,
  0.95, // strictly highest billing base — always closest to "invoice" query (0.95)
  1,
  15,
)

const TAX_CHUNK = makeChunk(
  'tax-chunk-001',
  'src/billing/tax-calculator.ts',
  'TaxCalculator',
  `export class TaxCalculator {
  calculate(amount: number, region: string): TaxResult {
    const rate = this.rates.get(region) ?? 0.2
    return { base: amount, tax: amount * rate, total: amount * (1 + rate), region }
  }
}`,
  0.85, // lower than invoice — second closest to "invoice" query (0.95)
  1,
  10,
)

const TOKEN_CHUNK = makeChunk(
  'token-chunk-001',
  'src/auth/token.service.ts',
  'TokenService',
  `export class TokenService {
  sign(payload: TokenPayload): SignedToken {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return { token: \`\${encoded}.\${this.hmac(encoded)}\`, expiresAt: new Date() }
  }
  verify(token: string): VerifyResult {
    const [encoded, sig] = token.split('.')
    return sig === this.hmac(encoded ?? '') ? { valid: true } : { valid: false, reason: 'bad sig' }
  }
}`,
  0.1, // far from billing — never surfaces in billing queries
  1,
  15,
)

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string
let store: LanceDBStore
let symbolIndex: SQLiteSymbolIndex

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'rag-retrieval-test-'))

  store = new LanceDBStore('.rag-test', tmpDir, 'nomic-embed-text')
  await store.upsert([INVOICE_CHUNK, TAX_CHUNK, TOKEN_CHUNK])

  symbolIndex = new SQLiteSymbolIndex('.rag-test', tmpDir)

  // Seed symbol index: InvoiceService calls TaxCalculator.calculate → cross-chunk edge
  const defs: SymbolDef[] = [
    { name: 'InvoiceService', kind: 'class', path: 'src/billing/invoice.service.ts', startLine: 1, endLine: 15, chunkId: INVOICE_CHUNK.id },
    { name: 'TaxCalculator',  kind: 'class', path: 'src/billing/tax-calculator.ts',  startLine: 1, endLine: 10, chunkId: TAX_CHUNK.id },
    { name: 'TokenService',   kind: 'class', path: 'src/auth/token.service.ts',       startLine: 1, endLine: 15, chunkId: TOKEN_CHUNK.id },
  ]
  const refs: SymbolRef[] = [
    // invoice.service references TaxCalculator (type ref + call)
    { name: 'TaxCalculator', path: 'src/billing/invoice.service.ts', line: 2, chunkId: INVOICE_CHUNK.id },
  ]
  await symbolIndex.upsert(defs, refs)
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('retrieval integration', () => {
  it('vectorSearch for "invoice" returns billing/invoice.service.ts as top result', async () => {
    const embedder = new OllamaEmbedder('nomic-embed-text')
    const [qVec] = await embedder.embed(['invoice issue customer billing'], 'query')
    const results = await store.vectorSearch(qVec!, 5)

    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.chunk.path).toBe('src/billing/invoice.service.ts')
    expect(results[0]!.source).toBe('vector')
  })

  it('textSearch for "TaxCalculator" returns tax-calculator.ts chunk', async () => {
    const results = await store.textSearch('TaxCalculator', 5)

    expect(results.length).toBeGreaterThan(0)
    const paths = results.map(r => r.chunk.path)
    expect(paths).toContain('src/billing/tax-calculator.ts')
  })

  it('vectorSearch with pathPrefix filter excludes auth/token.service.ts', async () => {
    const embedder = new OllamaEmbedder('nomic-embed-text')
    const [qVec] = await embedder.embed(['invoice billing tax'], 'query')
    const results = await store.vectorSearch(qVec!, 10, { pathPrefix: 'src/billing' })

    const authPaths = results.filter(r => r.chunk.path.startsWith('src/auth/'))
    expect(authPaths).toHaveLength(0)
  })

  it('HybridRetriever.retrieve with pathPrefix restricts to billing files', async () => {
    const embedder = new OllamaEmbedder('nomic-embed-text')
    const retriever = new HybridRetriever(store, embedder, 10, 10, symbolIndex)

    const results = await retriever.retrieve('invoice service', {
      k: 5,
      filter: { pathPrefix: 'src/billing' },
    })

    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.chunk.path).not.toContain('src/auth/')
    }
  })

  it('HybridRetriever.retrieve with expand:true returns TaxCalculator as neighbor of InvoiceService', async () => {
    const embedder = new OllamaEmbedder('nomic-embed-text')
    const retriever = new HybridRetriever(
      store,
      embedder,
      10,
      10,
      symbolIndex,
      /* expandMaxTokens */ 8192,
      /* expandDepth */ 1,
    )

    const results = await retriever.retrieve('invoice issue', {
      k: 3,
      expand: true,
    })

    // With expansion enabled, TaxCalculator must appear because InvoiceService
    // has a ref to TaxCalculator in the symbol graph (seeded in beforeAll).
    const paths = results.map(r => r.chunk.path)
    const hasTax = paths.some(p => p.includes('tax-calculator'))
    expect(hasTax).toBe(true)
  })

  it('store.getByIds returns the correct chunks', async () => {
    const results = await store.getByIds([INVOICE_CHUNK.id, TOKEN_CHUNK.id])
    expect(results).toHaveLength(2)
    const ids = results.map(r => r.chunk.id)
    expect(ids).toContain(INVOICE_CHUNK.id)
    expect(ids).toContain(TOKEN_CHUNK.id)
    expect(results[0]!.source).toBe('expanded')
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
