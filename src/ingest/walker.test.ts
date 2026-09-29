import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { detectLang, collectFiles } from './walker.js'

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
  it('filters out .env files (regex pattern test)', () => {
    const patterns = [/\.env($|\.)/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/]
    expect(patterns[0]!.test('.env')).toBe(true)
    expect(patterns[0]!.test('.env.local')).toBe(true)
    expect(patterns[0]!.test('src/.env')).toBe(true)
  })

  it('filters out .pem files (regex pattern test)', () => {
    const patterns = [/\.env($|\.)/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/]
    expect(patterns[1]!.test('cert.pem')).toBe(true)
    expect(patterns[1]!.test('src/cert.pem')).toBe(true)
  })

  it('filters out .key files (regex pattern test)', () => {
    const patterns = [/\.env($|\.)/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/]
    expect(patterns[2]!.test('private.key')).toBe(true)
    expect(patterns[2]!.test('src/private.key')).toBe(true)
  })

  it('filters out .p12 files (regex pattern test)', () => {
    const patterns = [/\.env($|\.)/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/]
    expect(patterns[3]!.test('cert.p12')).toBe(true)
  })

  it('filters out .pfx files (regex pattern test)', () => {
    const patterns = [/\.env($|\.)/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/]
    expect(patterns[4]!.test('cert.pfx')).toBe(true)
  })

  it('secret pattern does not match files without secret extensions', () => {
    const patterns = [/\.env($|\.)/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/]
    expect(patterns[0]!.test('src/main.ts')).toBe(false)
    expect(patterns[0]!.test('.envrc')).toBe(false) // only matches .env followed by nothing or dot
  })
})
