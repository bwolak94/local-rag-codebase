import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { makeTestConfig } from '../../test/helpers.js'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn(),
}))

vi.mock('../store/factory.js', () => ({
  createStore: vi.fn().mockReturnValue({}),
}))

vi.mock('../embedding/factory.js', () => ({
  createEmbedder: vi.fn().mockReturnValue({}),
}))

vi.mock('../symbols/index.js', () => ({
  SQLiteSymbolIndex: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../generation/budget.js', () => ({
  allocateBudget: vi.fn().mockReturnValue({ contextTokens: 16000, historyTokens: 4000 }),
}))

vi.mock('../retrieval/hybrid.js', () => ({
  HybridRetriever: vi.fn().mockImplementation(() => ({ retrieve: vi.fn() })),
}))

const mockStartMCPServer = vi.fn()
const mockCreateMCPServer = vi.fn()

vi.mock('../mcp/server.js', () => ({
  startMCPServer: mockStartMCPServer,
  createMCPServer: mockCreateMCPServer,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runServeMcpAction(args: string[] = []): Promise<void> {
  const { register } = await import('./serve-mcp.js')
  const program = new Command()
  program.exitOverride()
  register(program)
  await program.parseAsync(['node', 'cli', 'serve-mcp', ...args])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serve-mcp CLI command', () => {
  beforeEach(async () => {
    const { loadConfig } = await import('../config/loader.js')
    vi.mocked(loadConfig).mockReturnValue(makeTestConfig())

    // allocateBudget must be re-set after vi.restoreAllMocks() clears it
    const { allocateBudget } = await import('../generation/budget.js')
    vi.mocked(allocateBudget).mockReturnValue({ contextTokens: 16000, historyTokens: 4000 })

    mockStartMCPServer.mockResolvedValue(undefined)
    mockCreateMCPServer.mockReturnValue({ connect: vi.fn().mockResolvedValue(undefined) })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockStartMCPServer.mockReset()
    mockCreateMCPServer.mockReset()
  })

  // -------------------------------------------------------------------------
  // Server starts
  // -------------------------------------------------------------------------

  it('calls startMCPServer without throwing', async () => {
    await expect(runServeMcpAction()).resolves.toBeUndefined()
    expect(mockStartMCPServer).toHaveBeenCalledOnce()
  })

  it('passes the loaded config as the first argument to startMCPServer', async () => {
    const config = makeTestConfig({ root: '/my/repo' })
    const { loadConfig } = await import('../config/loader.js')
    vi.mocked(loadConfig).mockReturnValue(config)

    await runServeMcpAction()

    const [passedConfig] = mockStartMCPServer.mock.calls[0]
    expect(passedConfig).toMatchObject({ root: '/my/repo' })
  })

  it('passes a ToolContext with retriever, symbolIndex, and root to startMCPServer', async () => {
    await runServeMcpAction()

    const [, ctx] = mockStartMCPServer.mock.calls[0]
    expect(ctx).toHaveProperty('retriever')
    expect(ctx).toHaveProperty('symbolIndex')
    expect(ctx).toHaveProperty('root')
  })

  it('passes config.root as ctx.root to startMCPServer', async () => {
    const config = makeTestConfig({ root: '/project/root' })
    const { loadConfig } = await import('../config/loader.js')
    vi.mocked(loadConfig).mockReturnValue(config)

    await runServeMcpAction()

    const [, ctx] = mockStartMCPServer.mock.calls[0]
    expect(ctx.root).toBe('/project/root')
  })

  // -------------------------------------------------------------------------
  // HybridRetriever is constructed with config (HIGH-1 bug guard)
  // -------------------------------------------------------------------------

  it('constructs HybridRetriever with config as the 4th argument (not undefined)', async () => {
    const { HybridRetriever } = await import('../retrieval/hybrid.js')

    await runServeMcpAction()

    expect(vi.mocked(HybridRetriever)).toHaveBeenCalledOnce()
    const ctorArgs = vi.mocked(HybridRetriever).mock.calls[0]
    // 4th argument (index 3) is the config — must not be undefined
    expect(ctorArgs[3]).toBeDefined()
    expect(ctorArgs[3]).toMatchObject({ store: { driver: 'lancedb' } })
  })

  // -------------------------------------------------------------------------
  // Error propagation
  // -------------------------------------------------------------------------

  it('rejects if startMCPServer throws', async () => {
    mockStartMCPServer.mockRejectedValue(new Error('transport error'))
    await expect(runServeMcpAction()).rejects.toThrow('transport error')
  })
})
