import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { detectLang, collectFiles } from './walker.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs')
  return actual
})

describe('detectLang', () => {
  it('maps .ts to typescript', () => {
    expect(detectLang('src/file.ts')).toBe('typescript')
  })

  it('maps .tsx to tsx', () => {
    expect(detectLang('src/file.tsx')).toBe('tsx')
  })

  it('maps .js to javascript', () => {
    expect(detectLang('src/file.js')).toBe('javascript')
  })

  it('maps .jsx to javascript', () => {
    expect(detectLang('src/file.jsx')).toBe('javascript')
  })

  it('maps .py to python', () => {
    expect(detectLang('src/file.py')).toBe('python')
  })

  it('maps .vue to vue', () => {
    expect(detectLang('src/file.vue')).toBe('vue')
  })

  it('maps .php to php', () => {
    expect(detectLang('src/file.php')).toBe('php')
  })

  it('maps .json to json', () => {
    expect(detectLang('src/file.json')).toBe('json')
  })

  it('maps .md to markdown', () => {
    expect(detectLang('src/file.md')).toBe('markdown')
  })

  it('maps .css to css', () => {
    expect(detectLang('src/file.css')).toBe('css')
  })

  it('maps .html to html', () => {
    expect(detectLang('src/file.html')).toBe('html')
  })

  it('maps .mjs to javascript', () => {
    expect(detectLang('src/file.mjs')).toBe('javascript')
  })

  it('maps .cjs to javascript', () => {
    expect(detectLang('src/file.cjs')).toBe('javascript')
  })

  it('maps .yaml to yaml', () => {
    expect(detectLang('src/file.yaml')).toBe('yaml')
  })

  it('maps .yml to yaml', () => {
    expect(detectLang('src/file.yml')).toBe('yaml')
  })

  it('maps unknown extension to text', () => {
    expect(detectLang('src/file.unknown')).toBe('text')
    expect(detectLang('src/file')).toBe('text')
  })

  it('is case-insensitive', () => {
    expect(detectLang('src/file.TS')).toBe('typescript')
    expect(detectLang('src/file.Ts')).toBe('typescript')
  })
})

describe('collectFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'walker-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('filters out .env files by not including them in result', async () => {
    const { execSync } = await import('node:child_process')
    const mockedExecSync = vi.mocked(execSync)

    // Create test files
    writeFileSync(join(tmpDir, '.env'), 'SECRET=value')
    writeFileSync(join(tmpDir, 'main.ts'), 'export const x = 1')

    // Mock git ls-files to return both files
    mockedExecSync.mockReturnValue('.env\nmain.ts')

    const result = await collectFiles(tmpDir, ['**'], [], 200_000)

    // Assert .env is NOT in result but main.ts IS
    const paths = result.map(f => f.path)
    expect(paths).not.toContain('.env')
    expect(paths).toContain('main.ts')
  })

  it('filters out .pem files by not including them in result', async () => {
    const { execSync } = await import('node:child_process')
    const mockedExecSync = vi.mocked(execSync)

    writeFileSync(join(tmpDir, 'cert.pem'), '-----BEGIN CERTIFICATE-----')
    writeFileSync(join(tmpDir, 'main.ts'), 'export const x = 1')

    mockedExecSync.mockReturnValue('cert.pem\nmain.ts')

    const result = await collectFiles(tmpDir, ['**'], [], 200_000)

    const paths = result.map(f => f.path)
    expect(paths).not.toContain('cert.pem')
    expect(paths).toContain('main.ts')
  })

  it('filters out .key files by not including them in result', async () => {
    const { execSync } = await import('node:child_process')
    const mockedExecSync = vi.mocked(execSync)

    writeFileSync(join(tmpDir, 'private.key'), '-----BEGIN PRIVATE KEY-----')
    writeFileSync(join(tmpDir, 'main.ts'), 'export const x = 1')

    mockedExecSync.mockReturnValue('private.key\nmain.ts')

    const result = await collectFiles(tmpDir, ['**'], [], 200_000)

    const paths = result.map(f => f.path)
    expect(paths).not.toContain('private.key')
    expect(paths).toContain('main.ts')
  })

  it('allows normal TypeScript files to be included', async () => {
    const { execSync } = await import('node:child_process')
    const mockedExecSync = vi.mocked(execSync)

    writeFileSync(join(tmpDir, 'utils.ts'), 'export function add(a, b) { return a + b }')

    mockedExecSync.mockReturnValue('utils.ts')

    const result = await collectFiles(tmpDir, ['**'], [], 200_000)

    const paths = result.map(f => f.path)
    expect(paths).toContain('utils.ts')
  })

  it('real integration test: secret filter excludes multiple secret file types', async () => {
    const { execSync } = await import('node:child_process')
    const mockedExecSync = vi.mocked(execSync)

    // Create multiple files including secrets
    writeFileSync(join(tmpDir, '.env'), 'DB_PASSWORD=secret')
    writeFileSync(join(tmpDir, '.env.local'), 'API_KEY=secret123')
    writeFileSync(join(tmpDir, 'cert.pem'), 'cert content')
    writeFileSync(join(tmpDir, 'secret.key'), 'key content')
    writeFileSync(join(tmpDir, 'app.ts'), 'export const app = createApp()')
    writeFileSync(join(tmpDir, 'lib.js'), 'export function helper() {}')

    // Mock git ls-files to return all files
    mockedExecSync.mockReturnValue('.env\n.env.local\ncert.pem\nsecret.key\napp.ts\nlib.js')

    const result = await collectFiles(tmpDir, ['**'], [], 200_000)

    const paths = result.map(f => f.path)
    // Secrets should be filtered out
    expect(paths).not.toContain('.env')
    expect(paths).not.toContain('.env.local')
    expect(paths).not.toContain('cert.pem')
    expect(paths).not.toContain('secret.key')
    // Normal files should be included
    expect(paths).toContain('app.ts')
    expect(paths).toContain('lib.js')
  })

  it('filters out files larger than maxFileBytes', async () => {
    const { execSync } = await import('node:child_process')
    const mockedExecSync = vi.mocked(execSync)

    const bigContent = 'x'.repeat(500)
    const smallContent = 'export const x = 1'

    writeFileSync(join(tmpDir, 'big.ts'), bigContent)
    writeFileSync(join(tmpDir, 'small.ts'), smallContent)

    mockedExecSync.mockReturnValue('big.ts\nsmall.ts')

    // maxFileBytes = 100, big.ts is 500 bytes → should be excluded
    const result = await collectFiles(tmpDir, ['**'], [], 100)

    const paths = result.map(f => f.path)
    expect(paths).not.toContain('big.ts')
    expect(paths).toContain('small.ts')
  })

  it('restricts to .ts files when include is ["**/*.ts"]', async () => {
    const { execSync } = await import('node:child_process')
    const mockedExecSync = vi.mocked(execSync)

    writeFileSync(join(tmpDir, 'module.ts'), 'export const a = 1')
    writeFileSync(join(tmpDir, 'script.js'), 'const b = 2')

    mockedExecSync.mockReturnValue('module.ts\nscript.js')

    const result = await collectFiles(tmpDir, ['**/*.ts'], [], 200_000)

    const paths = result.map(f => f.path)
    expect(paths).toContain('module.ts')
    expect(paths).not.toContain('script.js')
  })

  it('excludes files inside generated/ directory via exclude glob', async () => {
    const { execSync } = await import('node:child_process')
    const { mkdirSync } = await import('node:fs')
    const mockedExecSync = vi.mocked(execSync)

    mkdirSync(join(tmpDir, 'generated'), { recursive: true })
    writeFileSync(join(tmpDir, 'generated', 'auto.ts'), 'export const auto = true')
    writeFileSync(join(tmpDir, 'handwritten.ts'), 'export const hand = true')

    mockedExecSync.mockReturnValue('generated/auto.ts\nhandwritten.ts')

    const result = await collectFiles(tmpDir, ['**'], ['**/generated/**'], 200_000)

    const paths = result.map(f => f.path)
    expect(paths).not.toContain('generated/auto.ts')
    expect(paths).toContain('handwritten.ts')
  })
})
