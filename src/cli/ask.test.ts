import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { makeTestConfig } from '../../test/helpers.js'

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any dynamic imports
// ---------------------------------------------------------------------------

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn(),
}))

vi.mock('../store/factory.js', () => ({
  createStore: vi.fn(),
}))

vi.mock('../embedding/factory.js', () => ({
  createEmbedder: vi.fn(),
}))

vi.mock('../symbols/index.js', () => ({
  SQLiteSymbolIndex: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../generation/budget.js', () => ({
  allocateBudget: vi.fn().mockReturnValue({ contextTokens: 16000, historyTokens: 4000 }),
}))

vi.mock('../retrieval/hybrid.js', () => ({
  HybridRetriever: vi.fn(),
}))

vi.mock('../generation/chat.js', () => ({
  OllamaGenerator: vi.fn(),
}))

vi.mock('../agent/loop.js', () => ({
  agentLoop: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runAskAction(args: string[]): Promise<void> {
  // Re-import to pick up fresh mocks each time
  const { register } = await import('./ask.js')
  const program = new Command()
  program.exitOverride() // prevent commander calling process.exit
  register(program)
  await program.parseAsync(['node', 'cli', 'ask', ...args])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ask CLI command', () => {
  let mockRetrieve: ReturnType<typeof vi.fn>
  let mockAnswer: ReturnType<typeof vi.fn>
  let mockAgentLoop: ReturnType<typeof vi.fn>
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    const config = makeTestConfig()

    // loadConfig returns the test config synchronously (ask.ts calls it synchronously)
    const { loadConfig } = await import('../config/loader.js')
    vi.mocked(loadConfig).mockReturnValue(config)

    // createStore / createEmbedder return stubs
    const { createStore } = await import('../store/factory.js')
    const { createEmbedder } = await import('../embedding/factory.js')
    vi.mocked(createStore).mockReturnValue({} as never)
    vi.mocked(createEmbedder).mockReturnValue({} as never)

    // allocateBudget must be re-set after vi.restoreAllMocks() clears it
    const { allocateBudget } = await import('../generation/budget.js')
    vi.mocked(allocateBudget).mockReturnValue({ contextTokens: 16000, historyTokens: 4000 })

    // HybridRetriever mock
    mockRetrieve = vi.fn().mockResolvedValue([])
    const { HybridRetriever } = await import('../retrieval/hybrid.js')
    vi.mocked(HybridRetriever).mockImplementation(() => ({ retrieve: mockRetrieve }) as never)

    // OllamaGenerator mock — answer() is an async generator that yields one token
    mockAnswer = vi.fn().mockReturnValue(
      (async function* () { yield 'result' })(),
    )
    const { OllamaGenerator } = await import('../generation/chat.js')
    vi.mocked(OllamaGenerator).mockImplementation(() => ({ answer: mockAnswer }) as never)

    // agentLoop mock
    mockAgentLoop = vi.fn().mockResolvedValue({ answer: 'agent answer', steps: 1, toolsUsed: [] })
    const { agentLoop } = await import('../agent/loop.js')
    vi.mocked(agentLoop).mockImplementation(mockAgentLoop)

    // spy on process.exit to prevent test runner exit
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })

    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // --k validation
  // -------------------------------------------------------------------------

  it('exits with error when --k 0 is passed', async () => {
    await expect(runAskAction(['--k', '0', 'what is this?'])).rejects.toThrow('process.exit')
    expect(consoleErrorSpy).toHaveBeenCalledWith('--k must be a positive integer')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockRetrieve).not.toHaveBeenCalled()
  })

  it('exits with error when --k -1 is passed', async () => {
    await expect(runAskAction(['--k', '-1', 'what is this?'])).rejects.toThrow('process.exit')
    expect(consoleErrorSpy).toHaveBeenCalledWith('--k must be a positive integer')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockRetrieve).not.toHaveBeenCalled()
  })

  it('exits with error when --k is not a number', async () => {
    await expect(runAskAction(['--k', 'abc', 'what is this?'])).rejects.toThrow('process.exit')
    expect(consoleErrorSpy).toHaveBeenCalledWith('--k must be a positive integer')
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(mockRetrieve).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Valid --k
  // -------------------------------------------------------------------------

  it('calls retrieve with k: 5 when --k 5 is passed', async () => {
    await runAskAction(['--k', '5', 'how does the store work?'])
    expect(mockRetrieve).toHaveBeenCalledOnce()
    const callArgs = mockRetrieve.mock.calls[0]
    expect(callArgs[1]).toMatchObject({ k: 5 })
  })

  it('calls retrieve with the default k 8 when no --k flag', async () => {
    await runAskAction(['how does the store work?'])
    expect(mockRetrieve).toHaveBeenCalledOnce()
    const callArgs = mockRetrieve.mock.calls[0]
    expect(callArgs[1]).toMatchObject({ k: 8 })
  })

  // -------------------------------------------------------------------------
  // --expand flag
  // -------------------------------------------------------------------------

  it('calls retrieve with expand: true when --expand is passed', async () => {
    await runAskAction(['--expand', 'what does the chunker do?'])
    expect(mockRetrieve).toHaveBeenCalledOnce()
    const callArgs = mockRetrieve.mock.calls[0]
    expect(callArgs[1]).toMatchObject({ expand: true })
  })

  it('calls retrieve with expand: false when config.retrieval.expandDepth is 0 and no --expand', async () => {
    // Override config so expandDepth = 0 (no implicit expand)
    const { loadConfig } = await import('../config/loader.js')
    const configNoExpand = makeTestConfig({ retrieval: { expandDepth: 0 } })
    vi.mocked(loadConfig).mockReturnValue(configNoExpand)

    await runAskAction(['what does the chunker do?'])
    expect(mockRetrieve).toHaveBeenCalledOnce()
    const callArgs = mockRetrieve.mock.calls[0]
    expect(callArgs[1]).toMatchObject({ expand: false })
  })

  // -------------------------------------------------------------------------
  // Non-agent mode (default)
  // -------------------------------------------------------------------------

  it('calls OllamaGenerator.answer directly when no --agent flag', async () => {
    await runAskAction(['what is a chunk?'])
    expect(mockAnswer).toHaveBeenCalledOnce()
    expect(mockAgentLoop).not.toHaveBeenCalled()
  })

  it('passes the question and context to OllamaGenerator.answer', async () => {
    const fakeContext = [{ score: 1, chunk: { path: 'src/x.ts', startLine: 1, endLine: 5 } }]
    mockRetrieve.mockResolvedValue(fakeContext)

    await runAskAction(['how does chunking work?'])
    expect(mockAnswer).toHaveBeenCalledWith('how does chunking work?', fakeContext)
  })

  // -------------------------------------------------------------------------
  // Agent mode
  // -------------------------------------------------------------------------

  it('calls agentLoop when --agent flag is present', async () => {
    await runAskAction(['--agent', 'explain the pipeline'])
    expect(mockAgentLoop).toHaveBeenCalledOnce()
    // OllamaGenerator.answer must NOT have been called
    expect(mockAnswer).not.toHaveBeenCalled()
  })

  it('passes question to agentLoop as first argument', async () => {
    await runAskAction(['--agent', 'explain the pipeline'])
    expect(mockAgentLoop.mock.calls[0][0]).toBe('explain the pipeline')
  })

  it('writes agentLoop answer to stdout', async () => {
    mockAgentLoop.mockResolvedValue({ answer: 'agent says hello', steps: 2, toolsUsed: ['semantic_search'] })
    await runAskAction(['--agent', 'a question'])
    const written = stdoutSpy.mock.calls.map(c => c[0]).join('')
    expect(written).toContain('agent says hello')
  })
})
