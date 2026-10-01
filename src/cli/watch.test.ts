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

const { mockPipelineRun, mockCreateWatcher, mockWatcherClose } = vi.hoisted(() => ({
  mockPipelineRun: vi.fn(),
  mockCreateWatcher: vi.fn(),
  mockWatcherClose: vi.fn(),
}))

vi.mock('../ingest/pipeline.js', () => ({
  IndexPipeline: vi.fn().mockImplementation(() => ({
    run: mockPipelineRun,
  })),
}))

vi.mock('../ingest/watcher.js', () => ({
  createWatcher: mockCreateWatcher,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runWatchAction(args: string[] = []): Promise<void> {
  const { register } = await import('./watch.js')
  const program = new Command()
  program.exitOverride()
  register(program)
  await program.parseAsync(['node', 'cli', 'watch', ...args])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('watch CLI command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    const config = makeTestConfig({
      root: '/repo',
      include: ['src/**', 'lib/**'],
      exclude: ['**/node_modules/**', '**/*.lock'],
    })
    const { loadConfig } = await import('../config/loader.js')
    vi.mocked(loadConfig).mockReturnValue(config)

    // Re-set after vi.restoreAllMocks() clears mockImplementation each test
    const { IndexPipeline } = await import('../ingest/pipeline.js')
    vi.mocked(IndexPipeline).mockImplementation(() => ({ run: mockPipelineRun }) as never)

    // Initial run returns a basic stats object; subsequent runs (from onChanges) too
    mockPipelineRun.mockResolvedValue({
      scanned: 5,
      changed: 0,
      added: 0,
      deleted: 0,
      chunks: 10,
      elapsed: 200,
    })

    mockCreateWatcher.mockReturnValue({ close: mockWatcherClose })

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    mockCreateWatcher.mockReset()
    mockPipelineRun.mockReset()
  })

  // -------------------------------------------------------------------------
  // Watcher is created with correct config values
  // -------------------------------------------------------------------------

  it('calls createWatcher with the root, include, and exclude from config', async () => {
    await runWatchAction()
    expect(mockCreateWatcher).toHaveBeenCalledOnce()
    const opts = mockCreateWatcher.mock.calls[0][0]
    expect(opts.root).toBe('/repo')
    expect(opts.include).toEqual(['src/**', 'lib/**'])
    expect(opts.exclude).toEqual(['**/node_modules/**', '**/*.lock'])
  })

  it('calls createWatcher exactly once regardless of how many files are in the initial index', async () => {
    await runWatchAction()
    expect(mockCreateWatcher).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // onChanges callback wires to pipeline.run
  // -------------------------------------------------------------------------

  it('onChanges callback calls pipeline.run with the provided paths', async () => {
    await runWatchAction()

    // Reset call count so we only count the onChanges-triggered run
    mockPipelineRun.mockClear()
    mockPipelineRun.mockResolvedValue({ scanned: 2, changed: 1, added: 0, deleted: 0, chunks: 3, elapsed: 50 })

    const { onChanges } = mockCreateWatcher.mock.calls[0][0] as { onChanges: (paths: string[]) => Promise<void> }
    await onChanges(['src/foo.ts', 'src/bar.ts'])

    expect(mockPipelineRun).toHaveBeenCalledOnce()
    expect(mockPipelineRun).toHaveBeenCalledWith({ paths: ['src/foo.ts', 'src/bar.ts'] })
  })

  it('onChanges callback logs each changed path', async () => {
    await runWatchAction()
    consoleLogSpy.mockClear()

    const { onChanges } = mockCreateWatcher.mock.calls[0][0] as { onChanges: (paths: string[]) => Promise<void> }
    await onChanges(['src/changed.ts'])

    const messages = consoleLogSpy.mock.calls.map(c => String(c[0]))
    expect(messages.some(m => m.includes('src/changed.ts'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Initial index run happens before watcher is started
  // -------------------------------------------------------------------------

  it('performs an initial pipeline.run() before creating the watcher', async () => {
    const callOrder: string[] = []
    mockPipelineRun.mockImplementation(async () => {
      callOrder.push('pipeline.run')
      return { scanned: 0, changed: 0, added: 0, deleted: 0, chunks: 0, elapsed: 0 }
    })
    mockCreateWatcher.mockImplementation((opts: unknown) => {
      callOrder.push('createWatcher')
      return { close: mockWatcherClose }
    })

    await runWatchAction()

    expect(callOrder[0]).toBe('pipeline.run')
    expect(callOrder[1]).toBe('createWatcher')
  })

  // -------------------------------------------------------------------------
  // Debounce: createWatcher is responsible for debouncing — CLI only calls it once
  // -------------------------------------------------------------------------

  it('does not call createWatcher more than once (debounce is internal to watcher)', async () => {
    await runWatchAction()
    expect(mockCreateWatcher).toHaveBeenCalledTimes(1)
  })

  // -------------------------------------------------------------------------
  // onChanges re-entrancy guard: zero-path note is logged when scanned===0
  // -------------------------------------------------------------------------

  it('logs a git-add note when onChanges paths are untracked (scanned=0, paths.length>0)', async () => {
    await runWatchAction()
    mockPipelineRun.mockResolvedValue({ scanned: 0, changed: 0, added: 0, deleted: 0, chunks: 0, elapsed: 0 })
    consoleLogSpy.mockClear()

    const { onChanges } = mockCreateWatcher.mock.calls[0][0] as { onChanges: (paths: string[]) => Promise<void> }
    await onChanges(['src/new-untracked.ts'])

    const messages = consoleLogSpy.mock.calls.map(c => String(c[0]))
    expect(messages.some(m => m.includes('git add'))).toBe(true)
  })
})
