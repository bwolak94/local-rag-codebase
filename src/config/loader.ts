import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
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
  let raw: unknown = {}
  if (file) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`Failed to parse ${file}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return RagConfigSchema.parse({ ...(raw as object), ...overrides })
}
