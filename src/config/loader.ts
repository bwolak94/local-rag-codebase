import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, isAbsolute, sep } from 'node:path'
import { RagConfigSchema, type RagConfig } from './schema.js'

export function findConfigFile(start = process.cwd()): string | null {
  let dir = start
  while (true) {
    const candidate = resolve(dir, '.ragconfig.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function loadConfig(overrides: Partial<RagConfig> = {}, configPath?: string): RagConfig {
  const file = configPath ?? findConfigFile()
  let raw: Record<string, unknown> = {}
  if (file) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch (e) {
      throw new Error(`Failed to parse ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
    // resolve relative 'root' against the config file's directory, not process.cwd()
    if (typeof raw['root'] === 'string' && !isAbsolute(raw['root'] as string)) {
      raw = { ...raw, root: resolve(dirname(file), raw['root'] as string) }
    }
  }
  // resolve relative 'root' in overrides against process.cwd()
  const resolvedOverrides = { ...overrides }
  if (typeof resolvedOverrides.root === 'string' && !isAbsolute(resolvedOverrides.root)) {
    resolvedOverrides.root = resolve(process.cwd(), resolvedOverrides.root)
  }
  const config = RagConfigSchema.parse({ ...raw, ...resolvedOverrides })
  const configBase = resolve(file ? dirname(file) : process.cwd())
  const resolvedRoot = resolve(configBase, config.root)
  if (!resolvedRoot.startsWith(configBase + sep) && resolvedRoot !== configBase) {
    throw new Error(`Config 'root' (${resolvedRoot}) must be within the config directory (${configBase})`)
  }
  return config
}
