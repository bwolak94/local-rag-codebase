import Parser from 'web-tree-sitter'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkHash, chunkId } from '../ingest/hasher.js'
import { SlidingWindowChunker } from './fallback.js'
import type { Chunk, ChunkKind, Chunker, SourceFile } from '../types/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SUPPORTED_LANGS = new Set(['typescript', 'tsx', 'javascript'])

const LANG_TO_WASM: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
}

// Inline S-expression queries per language
const TS_QUERY = `
(function_declaration name: (identifier) @name) @symbol
(method_definition name: (property_identifier) @name) @symbol
(class_declaration name: (type_identifier) @name) @symbol
(interface_declaration name: (type_identifier) @name) @symbol
(type_alias_declaration name: (type_identifier) @name) @symbol
(export_statement declaration: [
  (function_declaration name: (identifier) @name)
  (class_declaration name: (type_identifier) @name)
  (interface_declaration name: (type_identifier) @name)
  (type_alias_declaration name: (type_identifier) @name)
] @symbol)
`

const JS_QUERY = `
(function_declaration name: (identifier) @name) @symbol
(method_definition name: (property_identifier) @name) @symbol
(class_declaration name: (type_identifier) @name) @symbol
(arrow_function) @symbol
`

const QUERIES: Record<string, string> = {
  typescript: TS_QUERY,
  tsx: TS_QUERY,
  javascript: JS_QUERY,
}

let parserInitialized = false
const parsers = new Map<string, Parser>()

export async function getParser(lang: string): Promise<Parser | null> {
  if (!SUPPORTED_LANGS.has(lang)) return null

  if (parsers.has(lang)) return parsers.get(lang)!

  if (!parserInitialized) {
    await Parser.init()
    parserInitialized = true
  }

  const wasmName = LANG_TO_WASM[lang]
  if (!wasmName) return null

  // tree-sitter-wasms ships WASM files in its package
  const wasmPath = resolve(__dirname, '../../node_modules/tree-sitter-wasms/out', wasmName)
  const language = await Parser.Language.load(wasmPath)
  const parser = new Parser()
  parser.setLanguage(language)
  parsers.set(lang, parser)
  return parser
}

function kindFromNodeType(type: string): ChunkKind {
  if (type.includes('function')) return 'function'
  if (type.includes('method')) return 'method'
  if (type.includes('class')) return 'class'
  if (type.includes('interface')) return 'interface'
  if (type.includes('type_alias')) return 'type'
  return 'module'
}

const fallback = new SlidingWindowChunker()

export class TreeSitterChunker implements Chunker {
  supports(file: SourceFile): boolean {
    return SUPPORTED_LANGS.has(file.lang)
  }

  async chunk(file: SourceFile): Promise<Chunk[]> {
    const parser = await getParser(file.lang)
    if (!parser) return fallback.chunk(file)

    let tree: Parser.Tree
    try {
      tree = parser.parse(file.content)
    } catch {
      return fallback.chunk(file)
    }

    const queryStr = QUERIES[file.lang]
    if (!queryStr) return fallback.chunk(file)

    const language = parser.getLanguage()
    let query: Parser.Query
    try {
      query = language.query(queryStr)
    } catch {
      return fallback.chunk(file)
    }

    const matches = query.matches(tree.rootNode)
    const lines = file.content.split('\n')
    const chunks: Chunk[] = []
    const seen = new Set<number>() // startLine dedup

    for (const match of matches) {
      const symCapture = match.captures.find(c => c.name === 'symbol')
      const nameCapture = match.captures.find(c => c.name === 'name')
      if (!symCapture) continue

      const node = symCapture.node
      const startLine = node.startPosition.row + 1
      const endLine = node.endPosition.row + 1
      if (seen.has(startLine)) continue
      seen.add(startLine)

      const symbol = nameCapture?.node.text
      const kind = kindFromNodeType(node.type)
      const content = lines.slice(node.startPosition.row, node.endPosition.row + 1).join('\n')

      if (!content.trim()) continue

      const header = [
        `file:${file.path}`,
        symbol ? `symbol:${symbol}` : null,
        `kind:${kind}`,
        `lang:${file.lang}`,
        `lines:${startLine}-${endLine}`,
      ].filter(Boolean).join(' ')

      // split oversized symbols
      if (content.length > 2500) {
        const partLines = lines.slice(node.startPosition.row, node.endPosition.row + 1)
        const half = Math.floor(partLines.length / 2)
        const part1 = partLines.slice(0, half).join('\n')
        const part2 = partLines.slice(half).join('\n')

        const h1 = header + ' part:1'
        const h2 = header + ' part:2'
        chunks.push({
          id: chunkId(file.path, symbol ? `${symbol}:1` : undefined, startLine),
          path: file.path, lang: file.lang, kind, symbol,
          startLine, endLine: startLine + half - 1,
          header: h1, content: part1, hash: chunkHash(h1, part1),
        })
        chunks.push({
          id: chunkId(file.path, symbol ? `${symbol}:2` : undefined, startLine + half),
          path: file.path, lang: file.lang, kind, symbol,
          startLine: startLine + half, endLine,
          header: h2, content: part2, hash: chunkHash(h2, part2),
        })
        continue
      }

      chunks.push({
        id: chunkId(file.path, symbol, startLine),
        path: file.path, lang: file.lang, kind, symbol,
        startLine, endLine,
        header, content, hash: chunkHash(header, content),
      })
    }

    // if no symbols found, fall back to sliding window
    if (chunks.length === 0) return fallback.chunk(file)
    return chunks
  }
}
