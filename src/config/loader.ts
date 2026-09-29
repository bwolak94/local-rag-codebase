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
  const raw = file ? JSON.parse(readFileSync(file, 'utf8')) : {}
  return RagConfigSchema.parse({ ...raw, ...overrides })
}
