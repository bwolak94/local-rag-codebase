import { describe, it, expect, vi } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { createMCPServer } from './server.js'
import type { Retriever, SymbolIndex, ScoredChunk } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'
import type { ToolContext } from '../agent/tools.js'

// ── helpers ────────────────────────────────────────────────────────────────

function makeConfig(): RagConfig {
  return {
    root: '/tmp/test-root',
    include: ['src/**'],
    exclude: [],
    maxFileBytes: 200_000,
    embedding: { model: 'nomic-embed-text', batchSize: 48 },
    llm: { model: 'qwen2.5-coder:14b', host: 'http://localhost:11434', numCtx: 32768, temperature: 0.1, rewriteTemperature: 0.3 },
    retrieval: { kVector: 20, kFts: 20, kFinal: 8, expandDepth: 1, rewrite: false, rerank: 'none' },
    store: { driver: 'lancedb', path: '.rag' },
    budget: { contextFraction: 0.6, historyFraction: 0.2 },
  }
}

function makeChunk(id: string): ScoredChunk {
  return {
    chunk: {
      id,
      path: 'src/a.ts',
      lang: 'typescript',
      kind: 'function',
      symbol: 'myFn',
      startLine: 1,
      endLine: 10,
      header: '',
      content: 'function myFn() {}',
      hash: '',
    },
    score: 0.9,
    source: 'fused',
  }
}

function mockRetriever(results: ScoredChunk[] = []): Retriever {
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

function makeCtx(retriever: Retriever = mockRetriever(), symbolIndex: SymbolIndex = mockSymbolIndex()): ToolContext {
  return { retriever, symbolIndex, root: '/tmp/test-root' }
}

/**
 * Capture the request handlers registered by createMCPServer without accessing
 * private SDK fields. We spy on setRequestHandler before the server is created
 * and collect each (schema, handler) pair keyed by the schema method name.
 */
function captureHandlers(config: RagConfig, ctx: ToolContext): {
  server: Server
  handlers: Map<string, (req: unknown) => Promise<unknown>>
} {
  const handlers = new Map<string, (req: unknown) => Promise<unknown>>()

  // Spy before instantiation so we intercept the calls made inside createMCPServer
  const spy = vi.spyOn(Server.prototype, 'setRequestHandler').mockImplementation(
    function (this: Server, schema: { method?: string }, handler: (req: unknown) => Promise<unknown>) {
      // Determine the method name from the schema shape
      const method = (schema as { method?: string }).method
        // ZodObject schemas carry a shape with a `method` literal field
        ?? (schema as { shape?: { method?: { value?: string } } }).shape?.method?.value
        ?? String(schema)
      handlers.set(method, handler)
    }
  )

  const server = createMCPServer(config, ctx)

  spy.mockRestore()

  return { server, handlers }
}

// ── createMCPServer ────────────────────────────────────────────────────────

describe('createMCPServer', () => {
  it('returns a Server instance', () => {
    const server = createMCPServer(makeConfig(), makeCtx())
    expect(server).toBeInstanceOf(Server)
  })

  it('tools/list handler returns all 6 tools', async () => {
    const { handlers } = captureHandlers(makeConfig(), makeCtx())

    const listHandler = handlers.get('tools/list')
    expect(listHandler).toBeDefined()

    const response = await listHandler!({ method: 'tools/list', params: {} })
    const tools = (response as { tools: unknown[] }).tools
    expect(tools).toHaveLength(6)
  })

  it('each tool has name, description, and inputSchema', async () => {
    const { handlers } = captureHandlers(makeConfig(), makeCtx())
    const listHandler = handlers.get('tools/list')!

    const response = await listHandler({ method: 'tools/list', params: {} })
    const tools = (response as { tools: Array<{ name: string; description: string; inputSchema: object }> }).tools

    for (const tool of tools) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
      expect(typeof tool.inputSchema).toBe('object')
    }
  })

  it('all expected tool names are present', async () => {
    const { handlers } = captureHandlers(makeConfig(), makeCtx())
    const listHandler = handlers.get('tools/list')!

    const response = await listHandler({ method: 'tools/list', params: {} })
    const tools = (response as { tools: Array<{ name: string }> }).tools
    const names = tools.map(t => t.name)

    expect(names).toContain('semantic_search')
    expect(names).toContain('grep')
    expect(names).toContain('read_file')
    expect(names).toContain('find_symbol')
    expect(names).toContain('get_references')
    expect(names).toContain('list_dir')
  })

  it('semantic_search inputSchema includes minimum/maximum/multipleOf for k', async () => {
    const { handlers } = captureHandlers(makeConfig(), makeCtx())
    const listHandler = handlers.get('tools/list')!

    const response = await listHandler({ method: 'tools/list', params: {} })
    const tools = (response as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> }).tools
    const searchTool = tools.find(t => t.name === 'semantic_search')!

    const kSchema = searchTool.inputSchema.properties['k'] as Record<string, unknown>
    expect(kSchema).toBeDefined()
    expect(kSchema['minimum']).toBe(1)
    expect(kSchema['maximum']).toBe(20)
    // zod-to-json-schema represents .int() as type:"integer", not multipleOf:1
    expect(kSchema['type']).toBe('integer')
  })

  it('tools/call for semantic_search returns text content', async () => {
    const chunk = makeChunk('fn1')
    const ctx = makeCtx(mockRetriever([chunk]))
    const { handlers } = captureHandlers(makeConfig(), ctx)
    const callHandler = handlers.get('tools/call')!

    const response = await callHandler({
      method: 'tools/call',
      params: { name: 'semantic_search', arguments: { query: 'my function', k: 8 } },
    })

    const result = response as { content: Array<{ type: string; text: string }> }
    expect(result.content).toHaveLength(1)
    expect(result.content[0]?.type).toBe('text')
    expect(result.content[0]?.text).toContain('src/a.ts')
  })

  it('tools/call for unknown tool returns error response', async () => {
    const { handlers } = captureHandlers(makeConfig(), makeCtx())
    const callHandler = handlers.get('tools/call')!

    const response = await callHandler({
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    })

    const result = response as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Unknown tool: nonexistent_tool')
  })

  it('Zod validation error in tool args returns isError response', async () => {
    const { handlers } = captureHandlers(makeConfig(), makeCtx())
    const callHandler = handlers.get('tools/call')!

    // semantic_search requires `query` to be a string; passing a number should fail Zod validation
    const response = await callHandler({
      method: 'tools/call',
      params: { name: 'semantic_search', arguments: { query: 12345, k: 'not-a-number' } },
    })

    const result = response as { content: Array<{ type: string; text: string }>; isError?: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Error:')
  })
})
