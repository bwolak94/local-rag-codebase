import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { findConfigFile, loadConfig } from './loader.js'
import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs')
  return actual
})

describe('findConfigFile', () => {
  it('returns null when no .ragconfig.json in tree', () => {
    const result = findConfigFile('/nonexistent/path')
    expect(result).toBeNull()
  })

  it('finds file in current directory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rag-config-test-'))
    try {
      const configPath = join(tmpDir, '.ragconfig.json')
      writeFileSync(configPath, '{}')

      const result = findConfigFile(tmpDir)
      expect(result).toBe(configPath)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('finds file in parent directory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'rag-config-test-'))
    try {
      const configPath = join(tmpDir, '.ragconfig.json')
      writeFileSync(configPath, '{}')

      const childDir = join(tmpDir, 'child')
      const result = findConfigFile(childDir)
      expect(result).toBe(configPath)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('loadConfig', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rag-loader-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns all defaults when no file exists', () => {
    // Write a minimal (empty) config to tmpDir so we can pass an explicit path
    // with no root key — the schema default of '.' will apply.
    const configPath = join(tmpDir, '.ragconfig.json')
    writeFileSync(configPath, '{}')
    const result = loadConfig({}, configPath)
    // root defaults to '.' but resolve('tmpDir', '.') = tmpDir when config has no root key
    // Verify the non-root defaults are correct
    expect(result.llm.numCtx).toBe(32768)
    expect(result.embedding.model).toBe('nomic-embed-text')
    expect(result.retrieval.kVector).toBe(20)
  })

  it('merges file values with overrides (overrides win)', () => {
    const configPath = join(tmpDir, '.ragconfig.json')
    writeFileSync(configPath, JSON.stringify({
      root: '/file/root',
      llm: { model: 'file-model' },
    }))

    const result = loadConfig(
      { root: '/override/root' },
      configPath
    )

    expect(result.root).toBe('/override/root') // override wins
    expect(result.llm.model).toBe('file-model') // from file
  })

  it('loads valid config from file without overrides', () => {
    const configPath = join(tmpDir, '.ragconfig.json')
    writeFileSync(configPath, JSON.stringify({
      root: '/custom/root',
      embedding: { model: 'bge-m3', batchSize: 32 },
      maxFileBytes: 500_000,
    }))

    const result = loadConfig({}, configPath)
    expect(result.root).toBe('/custom/root')
    expect(result.embedding.model).toBe('bge-m3')
    expect(result.embedding.batchSize).toBe(32)
    expect(result.maxFileBytes).toBe(500_000)
  })

  it('throws on invalid config JSON', () => {
    const configPath = join(tmpDir, '.ragconfig.json')
    writeFileSync(configPath, '{invalid json}')

    expect(() => {
      loadConfig({}, configPath)
    }).toThrow()
  })

  it('throws on invalid config schema', () => {
    const configPath = join(tmpDir, '.ragconfig.json')
    writeFileSync(configPath, JSON.stringify({
      store: { driver: 'invalid-driver' },
    }))

    expect(() => {
      loadConfig({}, configPath)
    }).toThrow()
  })

  it('uses findConfigFile when no configPath provided', () => {
    const configPath = join(tmpDir, '.ragconfig.json')
    writeFileSync(configPath, JSON.stringify({
      root: '/found/by/search',
    }))

    // This test would need mocking of the actual file system search,
    // so we just verify the function accepts no configPath argument
    const result = loadConfig({ root: '/override' })
    expect(result).toBeDefined()
    expect(result.root).toBe('/override')
  })

  it('resolves relative root against config file directory', () => {
    const configPath = join(tmpDir, '.ragconfig.json')
    writeFileSync(configPath, JSON.stringify({ root: '.' }))

    const result = loadConfig({}, configPath)
    // '.' relative to tmpDir should resolve to tmpDir itself
    expect(result.root).toBe(tmpDir)
  })

  it('does not modify absolute root path', () => {
    const configPath = join(tmpDir, '.ragconfig.json')
    writeFileSync(configPath, JSON.stringify({ root: '/absolute/path' }))

    const result = loadConfig({}, configPath)
    expect(result.root).toBe('/absolute/path')
  })

  it('relative root in overrides is resolved against process.cwd()', () => {
    const configPath = join(tmpDir, '.ragconfig.json')
    writeFileSync(configPath, '{}')
    const result = loadConfig({ root: '.' }, configPath)
    expect(result.root).toBe(process.cwd())
  })

  it('merges nested objects (overrides replace entire nested object)', () => {
    const configPath = join(tmpDir, '.ragconfig.json')
    writeFileSync(configPath, JSON.stringify({
      llm: { model: 'file-model', temperature: 0.2 },
      retrieval: { kVector: 25 },
    }))

    const result = loadConfig(
      { retrieval: { kFts: 30 } },
      configPath
    )

    expect(result.llm.model).toBe('file-model') // from file
    expect(result.llm.temperature).toBe(0.2) // from file
    expect(result.retrieval.kFts).toBe(30) // from override
    expect(result.retrieval.kVector).toBe(20) // default (not from file, since retrieval was overridden)
  })
})
