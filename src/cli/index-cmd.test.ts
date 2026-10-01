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

const { mockRun } = vi.hoisted(() => ({ mockRun: vi.fn() }))

vi.mock('../ingest/pipeline.js', () => ({
  IndexPipeline: vi.fn().mockImplementation(() => ({
    run: mockRun,
  })),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runIndexAction(args: string[]): Promise<void> {
  const { register } = await import('./index-cmd.js')
  const program = new Command()
  program.exitOverride()
  register(program)
  await program.parseAsync(['node', 'cli', 'index', ...args])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('index CLI command', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    const { loadConfig } = await import('../config/loader.js')
    vi.mocked(loadConfig).mockReturnValue(makeTestConfig())

    // Re-set after vi.restoreAllMocks() clears mockImplementation each test
    const { IndexPipeline } = await import('../ingest/pipeline.js')
    vi.mocked(IndexPipeline).mockImplementation(() => ({ run: mockRun }) as never)

    mockRun.mockResolvedValue({
      scanned: 10,
      changed: 3,
      added: 2,
      deleted: 1,
      chunks: 25,
      elapsed: 1500,
    })

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Default run
  // -------------------------------------------------------------------------

  it('runs the pipeline with default options (full: false)', async () => {
    await runIndexAction([])
    expect(mockRun).toHaveBeenCalledOnce()
    expect(mockRun).toHaveBeenCalledWith({ full: false })
  })

  // -------------------------------------------------------------------------
  // --full flag
  // -------------------------------------------------------------------------

  it('passes { full: true } to pipeline.run when --full flag is given', async () => {
    await runIndexAction(['--full'])
    expect(mockRun).toHaveBeenCalledOnce()
    expect(mockRun).toHaveBeenCalledWith({ full: true })
  })

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  it('prints scanned/changed/added/deleted line to stdout', async () => {
    await runIndexAction([])
    const allOutput = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(allOutput).toContain('10 files scanned')
    expect(allOutput).toContain('3 changed')
    expect(allOutput).toContain('2 added')
    expect(allOutput).toContain('1 deleted')
  })

  it('prints chunks and elapsed time to stdout', async () => {
    await runIndexAction([])
    const allOutput = consoleLogSpy.mock.calls.map(c => String(c[0])).join('\n')
    expect(allOutput).toContain('25 chunks embedded')
    // elapsed 1500ms → 1.5s
    expect(allOutput).toContain('1.5s')
  })

  it('creates IndexPipeline with the loaded config', async () => {
    const { IndexPipeline } = await import('../ingest/pipeline.js')
    await runIndexAction([])
    expect(vi.mocked(IndexPipeline)).toHaveBeenCalledOnce()
    // First argument to the constructor should be the config
    const ctorArgs = vi.mocked(IndexPipeline).mock.calls[0]
    expect(ctorArgs[0]).toMatchObject({ store: { driver: 'lancedb' } })
  })
})
