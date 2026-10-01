import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Command } from 'commander'
import { makeTestConfig } from '../../test/helpers.js'

// ---------------------------------------------------------------------------
// readline mock — must be declared before module imports so vi.mock hoists it
// ---------------------------------------------------------------------------

// We need fine-grained control over what the user "types", so we keep a
// mutable reference to the question callback that the CLI registers via
// rl.question(), and an events map for rl.on().
type QuestionCb = (input: string) => void
type EventCb = (...args: unknown[]) => void

let _questionCb: QuestionCb | null = null
const _eventListeners: Record<string, EventCb[]> = {}

const mockRlInterface = {
  question: vi.fn((prompt: string, cb: QuestionCb) => {
    _questionCb = cb
  }),
  close: vi.fn(() => {
    // simulate the 'close' event that readline fires when rl.close() is called
    const listeners = _eventListeners['close'] ?? []
    for (const l of listeners) l()
  }),
  on: vi.fn((event: string, cb: EventCb) => {
    _eventListeners[event] = _eventListeners[event] ?? []
    _eventListeners[event].push(cb)
    return mockRlInterface // for chaining
  }),
}

vi.mock('node:readline', () => ({
  createInterface: vi.fn().mockReturnValue(mockRlInterface),
}))

// ---------------------------------------------------------------------------
// Other module mocks
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

const mockRetrieve = vi.fn()

vi.mock('../retrieval/hybrid.js', () => ({
  HybridRetriever: vi.fn().mockImplementation(() => ({ retrieve: mockRetrieve })),
}))

const mockAnswer = vi.fn()

vi.mock('../generation/chat.js', () => ({
  OllamaGenerator: vi.fn().mockImplementation(() => ({ answer: mockAnswer })),
}))

const mockCondensQuestion = vi.fn()

vi.mock('../retrieval/rewrite.js', () => ({
  condensQuestion: mockCondensQuestion,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Starts the chat command action and returns a "driver" that lets the test
 * simulate user input by calling sendInput(). The action never resolves on its
 * own (it loops on readline), so we also expose a `quit()` helper that feeds
 * 'exit' and awaits the close event.
 */
async function startChatSession(opts: string[] = []): Promise<{
  sendInput: (text: string) => Promise<void>
  quit: () => Promise<void>
  actionPromise: Promise<void>
}> {
  const { register } = await import('./chat.js')
  const program = new Command()
  program.exitOverride()
  register(program)

  // Reset state
  _questionCb = null
  for (const k of Object.keys(_eventListeners)) delete _eventListeners[k]

  // Start the action — it will hang waiting for readline
  const actionPromise = program
    .parseAsync(['node', 'cli', 'chat', ...opts])
    .catch(() => undefined) as Promise<void>

  // Flush microtask queue so the action runs up to the first rl.question() call
  await new Promise(r => setTimeout(r, 0))

  const sendInput = async (text: string): Promise<void> => {
    if (!_questionCb) throw new Error('readline question() was not called — action did not reach the prompt')
    const cb = _questionCb
    _questionCb = null
    // cb is typed as void but the actual callback is async — attach .catch()
    // immediately so Vitest never sees the rejection as unhandled (process.exit()
    // mock throws synchronously inside the close handler which propagates as a
    // rejection from the async callback)
    const cbResult = (cb(text) as unknown) as Promise<void> | undefined
    const cbSafe = cbResult instanceof Promise ? cbResult.catch(() => undefined) : Promise.resolve()
    // Flush async work triggered by the input
    await new Promise(r => setTimeout(r, 0))
    await cbSafe
  }

  const quit = async (): Promise<void> => {
    await sendInput('exit')
  }

  return { sendInput, quit, actionPromise }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chat CLI command', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    const { loadConfig } = await import('../config/loader.js')
    vi.mocked(loadConfig).mockReturnValue(makeTestConfig())

    // Re-set mockImplementations after vi.restoreAllMocks() clears them each test
    const { allocateBudget } = await import('../generation/budget.js')
    vi.mocked(allocateBudget).mockReturnValue({ contextTokens: 16000, historyTokens: 4000 })

    const { HybridRetriever } = await import('../retrieval/hybrid.js')
    vi.mocked(HybridRetriever).mockImplementation(() => ({ retrieve: mockRetrieve }) as never)

    const { OllamaGenerator } = await import('../generation/chat.js')
    vi.mocked(OllamaGenerator).mockImplementation(() => ({ answer: mockAnswer }) as never)

    // readline.createInterface mock loses its .mockReturnValue after restoreAllMocks()
    const readline = await import('node:readline')
    vi.mocked(readline.createInterface).mockReturnValue(mockRlInterface as never)

    mockRetrieve.mockResolvedValue([])
    // answer() is an async generator yielding one token
    mockAnswer.mockReturnValue(
      (async function* () { yield 'response text' })(),
    )
    mockCondensQuestion.mockResolvedValue('condensed question')

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockRetrieve.mockReset()
    mockAnswer.mockReset()
    mockCondensQuestion.mockReset()
    mockRlInterface.question.mockClear()
    mockRlInterface.close.mockClear()
    mockRlInterface.on.mockClear()
  })

  // -------------------------------------------------------------------------
  // Retriever is called with the user query
  // -------------------------------------------------------------------------

  it('calls retriever.retrieve with the user question on input', async () => {
    mockAnswer.mockReturnValue((async function* () { yield 'ok' })())

    const { sendInput, quit } = await startChatSession()
    await sendInput('how does chunking work?')
    await quit()

    expect(mockRetrieve).toHaveBeenCalledWith(
      'how does chunking work?',
      expect.objectContaining({ k: expect.any(Number) }),
    )
  })

  it('calls generator.answer with the question and retrieved context', async () => {
    const fakeContext = [{ score: 0.9, chunk: { path: 'src/a.ts', startLine: 1, endLine: 5 } }]
    mockRetrieve.mockResolvedValue(fakeContext)
    mockAnswer.mockReturnValue((async function* () { yield 'answer' })())

    const { sendInput, quit } = await startChatSession()
    await sendInput('what is RRF?')
    await quit()

    expect(mockAnswer).toHaveBeenCalledWith(
      'what is RRF?',
      fakeContext,
      expect.any(Array), // history
    )
  })

  // -------------------------------------------------------------------------
  // /quit / 'exit' command closes the loop
  // -------------------------------------------------------------------------

  it('closes readline when user types "exit"', async () => {
    const { quit } = await startChatSession()
    await quit()
    expect(mockRlInterface.close).toHaveBeenCalled()
  })

  it('handles "exit" as case-insensitive', async () => {
    const { sendInput } = await startChatSession()
    await sendInput('EXIT')
    expect(mockRlInterface.close).toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // HybridRetriever receives config as 4th arg (HIGH-1 bug guard)
  // -------------------------------------------------------------------------

  it('constructs HybridRetriever with config as 4th argument (not undefined)', async () => {
    const { HybridRetriever } = await import('../retrieval/hybrid.js')
    vi.mocked(HybridRetriever).mockClear()

    const { quit } = await startChatSession()
    await quit()

    expect(vi.mocked(HybridRetriever)).toHaveBeenCalledOnce()
    const ctorArgs = vi.mocked(HybridRetriever).mock.calls[0]
    // 4th argument (index 3) must be defined and be the config object
    expect(ctorArgs[3]).toBeDefined()
    expect(ctorArgs[3]).toMatchObject({ llm: { model: 'qwen2.5-coder:14b' } })
  })

  // -------------------------------------------------------------------------
  // History: condensQuestion is called on the second message
  // -------------------------------------------------------------------------

  it('does NOT call condensQuestion on the first message (no history)', async () => {
    // Enable rewrite in config
    const { loadConfig } = await import('../config/loader.js')
    vi.mocked(loadConfig).mockReturnValue(makeTestConfig({ retrieval: { rewrite: true } }))

    mockAnswer
      .mockReturnValueOnce((async function* () { yield 'first answer' })())
      .mockReturnValue((async function* () { yield 'second answer' })())

    const { sendInput, quit } = await startChatSession()
    await sendInput('first question')
    expect(mockCondensQuestion).not.toHaveBeenCalled()
    await quit()
  })

  it('calls condensQuestion on the second message when rewrite is enabled', async () => {
    const { loadConfig } = await import('../config/loader.js')
    vi.mocked(loadConfig).mockReturnValue(makeTestConfig({ retrieval: { rewrite: true } }))

    mockAnswer
      .mockReturnValueOnce((async function* () { yield 'first answer' })())
      .mockReturnValueOnce((async function* () { yield 'second answer' })())
      .mockReturnValue((async function* () { yield 'done' })())

    const { sendInput, quit } = await startChatSession()
    await sendInput('first question')
    await sendInput('second question')
    await quit()

    expect(mockCondensQuestion).toHaveBeenCalledOnce()
    // First arg to condensQuestion is history (non-empty), second is the follow-up
    const [history, followUp] = mockCondensQuestion.mock.calls[0]
    expect(history.length).toBeGreaterThan(0)
    expect(followUp).toBe('second question')
  })

  it('does NOT call condensQuestion when --no-rewrite flag is given', async () => {
    const { loadConfig } = await import('../config/loader.js')
    vi.mocked(loadConfig).mockReturnValue(makeTestConfig({ retrieval: { rewrite: true } }))

    mockAnswer
      .mockReturnValueOnce((async function* () { yield 'first answer' })())
      .mockReturnValueOnce((async function* () { yield 'second answer' })())
      .mockReturnValue((async function* () { yield 'done' })())

    const { sendInput, quit } = await startChatSession(['--no-rewrite'])
    await sendInput('first question')
    await sendInput('second question')
    await quit()

    expect(mockCondensQuestion).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Empty input is skipped (no retrieve call)
  // -------------------------------------------------------------------------

  it('skips empty input without calling retriever', async () => {
    const { sendInput, quit } = await startChatSession()
    await sendInput('   ')
    expect(mockRetrieve).not.toHaveBeenCalled()
    await quit()
  })

  // -------------------------------------------------------------------------
  // process.exit is called when readline emits close
  // -------------------------------------------------------------------------

  it('calls process.exit(0) when readline closes', async () => {
    const { quit, actionPromise } = await startChatSession()
    await expect(quit()).resolves.toBeUndefined()
    // actionPromise may reject with "process.exit" — that is acceptable
    await actionPromise.catch(() => undefined)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
