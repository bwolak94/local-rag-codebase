import { z } from 'zod'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { Retriever, SymbolIndex } from '../types/index.js'

export const SemanticSearchInput = z.object({
  query: z.string().describe('Natural language search query'),
  k: z.number().int().min(1).max(20).default(8).describe('Number of results'),
  path: z.string().optional().describe('Restrict to files under this path prefix'),
})

export const GrepInput = z.object({
  pattern: z.string().describe('Regex or literal pattern to search'),
  path: z.string().optional().describe('Restrict to files under this path prefix'),
})

export const ReadFileInput = z.object({
  path: z.string().describe('File path relative to repo root'),
  start: z.number().int().optional().describe('Start line (1-indexed, inclusive)'),
  end: z.number().int().optional().describe('End line (1-indexed, inclusive)'),
})

export const FindSymbolInput = z.object({
  name: z.string().describe('Symbol name (function, class, interface, etc.)'),
})

export const GetReferencesInput = z.object({
  symbol: z.string().describe('Symbol name to find usages of'),
})

export const ListDirInput = z.object({
  path: z.string().describe('Directory path relative to repo root'),
})

export interface ToolContext {
  retriever: Retriever
  symbolIndex: SymbolIndex
  root: string
}

function isSafePath(abs: string, root: string): boolean {
  const safeRoot = resolve(root)
  return abs === safeRoot || abs.startsWith(safeRoot + '/')
}

export async function semanticSearch(
  input: z.infer<typeof SemanticSearchInput>,
  ctx: ToolContext,
): Promise<string> {
  const results = await ctx.retriever.retrieve(input.query, {
    k: input.k,
    filter: input.path ? { pathPrefix: input.path } : undefined,
  })
  if (results.length === 0) return 'No results found.'
  return results.map(({ chunk, score }) => {
    const sym = chunk.symbol ? ` (${chunk.symbol})` : ''
    const safeSnippet = chunk.content.slice(0, 400).replace(/<\/chunk>/gi, '<\\/chunk>')
    return `[${chunk.path}:${chunk.startLine}-${chunk.endLine}${sym}] score=${score.toFixed(4)}\n${safeSnippet}`
  }).join('\n\n---\n\n')
}

export async function grep(
  input: z.infer<typeof GrepInput>,
  ctx: ToolContext,
): Promise<string> {
  const cwd = input.path ? resolve(ctx.root, input.path) : ctx.root
  if (input.path && !isSafePath(cwd, ctx.root)) {
    return 'Error: path outside repository root'
  }

  const result = spawnSync('git', ['grep', '-n', '-e', input.pattern], {
    cwd,
    encoding: 'utf8',
  })

  if (result.error) return `grep error: ${result.error.message}`
  if (result.status === 1 || (result.stdout === '' && result.stderr === '')) return 'No matches found.'
  if (result.status !== 0 && result.status !== 1) return `grep error: exit ${result.status ?? 'null'}`
  return result.stdout.trim() || 'No matches found.'
}

export function readFile(
  input: z.infer<typeof ReadFileInput>,
  ctx: ToolContext,
): string {
  const abs = resolve(ctx.root, input.path)
  // prevent path traversal outside root
  if (!isSafePath(abs, ctx.root)) return 'Error: path outside repository root'
  try {
    const lines = readFileSync(abs, 'utf8').split('\n')
    const start = (input.start ?? 1) - 1
    const end = input.end ?? lines.length
    return lines.slice(start, end).join('\n')
  } catch {
    return `Error: cannot read ${input.path}`
  }
}

export async function findSymbol(
  input: z.infer<typeof FindSymbolInput>,
  ctx: ToolContext,
): Promise<string> {
  const defs = await ctx.symbolIndex.definitions(input.name)
  if (defs.length === 0) return `No definitions found for '${input.name}'.`
  return defs.map(d => `${d.path}:${d.startLine}-${d.endLine} [${d.kind}]`).join('\n')
}

export async function getReferences(
  input: z.infer<typeof GetReferencesInput>,
  ctx: ToolContext,
): Promise<string> {
  const refs = await ctx.symbolIndex.references(input.symbol)
  if (refs.length === 0) return `No references found for '${input.symbol}'.`
  return refs.map(r => `${r.path}:${r.line}`).join('\n')
}

export function listDir(
  input: z.infer<typeof ListDirInput>,
  ctx: ToolContext,
): string {
  const abs = resolve(ctx.root, input.path)
  if (!isSafePath(abs, ctx.root)) return 'Error: path outside repository root'
  try {
    const allNames = readdirSync(abs)
    const capped = allNames.slice(0, 200)
    const lines = capped.map(name => {
      const full = resolve(abs, name)
      const stat = statSync(full)
      const rel = relative(ctx.root, full)
      return stat.isDirectory() ? `${rel}/` : `${rel} (${stat.size}B)`
    })
    if (allNames.length > 200) {
      lines.push(`\n… and ${allNames.length - 200} more entries`)
    }
    return lines.join('\n')
  } catch {
    return `Error: cannot list ${input.path}`
  }
}
