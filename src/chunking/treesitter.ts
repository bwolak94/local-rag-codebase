import Parser from 'web-tree-sitter'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { chunkHash, chunkId } from '../ingest/hasher.js'
import { SlidingWindowChunker } from './fallback.js'
import { kindFromNodeType } from './kinds.js'
import type { Chunk, Chunker, SourceFile } from '../types/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SUPPORTED_LANGS = new Set(['typescript', 'tsx', 'javascript', 'python', 'php', 'vue'])

const LANG_TO_WASM: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  php: 'tree-sitter-php.wasm',
}

const QUERIES: Record<string, string> = {
  typescript: readFileSync(resolve(__dirname, 'queries/typescript.scm'), 'utf8'),
  tsx: readFileSync(resolve(__dirname, 'queries/typescript.scm'), 'utf8'),
  javascript: readFileSync(resolve(__dirname, 'queries/javascript.scm'), 'utf8'),
  python: readFileSync(resolve(__dirname, 'queries/python.scm'), 'utf8'),
  php: readFileSync(resolve(__dirname, 'queries/php.scm'), 'utf8'),
}

let parserInitialized = false
const parsers = new Map<string, Parser>()
const compiledQueries = new Map<string, unknown>()

export async function getParser(lang: string): Promise<Parser | null> {
  if (!SUPPORTED_LANGS.has(lang)) return null
  // Vue is handled via script extraction — no WASM parser for vue itself
  if (lang === 'vue') return null

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

function findParentClass(node: Parser.SyntaxNode): string | undefined {
  let current = node.parent
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'class_definition') {
      return current.childForFieldName('name')?.text
    }
    current = current.parent
  }
  return undefined
}

function extractImports(rootNode: Parser.SyntaxNode): string[] {
  const imports: string[] = []
  for (const child of rootNode.children) {
    if (child.type === 'import_declaration') {
      const clause = child.childForFieldName('import_clause') ?? child.children.find(c => c.type === 'import_clause')
      if (clause) {
        // Default import: `import Foo from '...'`
        const defaultIdent = clause.children.find(c => c.type === 'identifier')
        if (defaultIdent) imports.push(defaultIdent.text)

        // Named imports: `import { A, B } from '...'`
        const namedImports = clause.children.find(c => c.type === 'named_imports')
        if (namedImports) {
          for (const specifier of namedImports.children) {
            if (specifier.type === 'import_specifier') {
              // The `name` field is the local binding identifier
              const ident = specifier.childForFieldName('name') ?? specifier.children.find(c => c.type === 'identifier')
              if (ident) imports.push(ident.text)
            }
          }
        }
      } else {
        // Side-effect import: `import 'side-effect'` — fall back to module basename
        const source = child.childForFieldName('source')?.text?.replace(/['"]/g, '')
        if (source) {
          const base = source.split('/').pop()?.replace(/\.[^.]+$/, '')
          if (base) imports.push(base)
        }
      }
    }
    // Python: import_statement, import_from_statement
    if (child.type === 'import_statement' || child.type === 'import_from_statement') {
      const name = child.childForFieldName('name')?.text ?? child.childForFieldName('module_name')?.text
      if (name) imports.push(name)
    }
  }
  return imports.slice(0, 6) // cap at 6 to avoid blowing the header size
}

const fallback = new SlidingWindowChunker()

export class TreeSitterChunker implements Chunker {
  supports(file: SourceFile): boolean {
    return SUPPORTED_LANGS.has(file.lang)
  }

  async chunk(file: SourceFile): Promise<Chunk[]> {
    if (file.lang === 'vue') return this.chunkVue(file)
    return this.chunkInner(file)
  }

  private async chunkVue(file: SourceFile): Promise<Chunk[]> {
    const re = /(<script([^>]*)>)([\s\S]*?)<\/script>/gi
    const allChunks: Chunk[] = []

    for (const match of file.content.matchAll(re)) {
      const openTag = match[1] ?? ''
      const scriptContent = match[3] ?? ''
      const isTs = /lang=["']ts["']/.test(openTag)
      const scriptLang = isTs ? 'typescript' : 'javascript'

      // use match.index + openTag.length to find exact script content start
      const scriptStart = (match.index ?? 0) + openTag.length
      const lineOffset = (file.content.slice(0, scriptStart).match(/\n/g) ?? []).length

      const syntheticFile: SourceFile = {
        path: file.path,
        lang: scriptLang,
        content: scriptContent,
        hash: file.hash,
      }

      const innerChunks = await this.chunkInner(syntheticFile)

      // adjust line offsets and fix lang back to vue
      const adjusted = innerChunks.map(c => {
        const startLine = c.startLine + lineOffset
        const endLine = c.endLine + lineOffset
        const header = c.header.replace(`lang:${scriptLang}`, 'lang:vue')
        return {
          ...c,
          path: file.path,
          lang: 'vue',
          startLine,
          endLine,
          header,
          id: chunkId(file.path, c.symbol, startLine),
          hash: chunkHash(header, c.content),
        }
      })

      allChunks.push(...adjusted)
    }

    if (allChunks.length === 0) return fallback.chunk(file)
    return allChunks
  }

  private async chunkInner(file: SourceFile): Promise<Chunk[]> {
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
      if (!compiledQueries.has(file.lang)) {
        compiledQueries.set(file.lang, language.query(queryStr))
      }
      query = compiledQueries.get(file.lang)! as Parser.Query
    } catch {
      return fallback.chunk(file)
    }

    const importsForFile = extractImports(tree.rootNode)
    const matches = query.matches(tree.rootNode)
    const lines = file.content.split('\n')
    const tinyChunks: Chunk[] = []
    const normalChunks: Chunk[] = []
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

      const parentClass = findParentClass(node)
      const headerParts = [
        `file:${file.path}`,
        symbol ? `symbol:${symbol}` : null,
        parentClass ? `parent:${parentClass}` : null,
        `kind:${kind}`,
        `lang:${file.lang}`,
        `lines:${startLine}-${endLine}`,
        importsForFile.length > 0 ? `imports:${importsForFile.join(',')}` : null,
      ].filter(Boolean) as string[]
      const header = headerParts.join(' ')

      // split oversized symbols
      if (content.length > 2500) {
        const partLines = lines.slice(node.startPosition.row, node.endPosition.row + 1)
        const totalLines = partLines.length
        const midpointRow = node.startPosition.row + Math.floor(totalLines / 2)

        // Find the last child node ending at or before the midpoint — logical split boundary
        let splitRow = Math.floor(totalLines / 2) // fallback: hard midpoint (0-based within partLines)
        for (const childNode of node.children) {
          if (childNode.endPosition.row <= midpointRow) {
            splitRow = childNode.endPosition.row - node.startPosition.row + 1
          }
        }
        // Guard: split must leave something in each part
        if (splitRow <= 0 || splitRow >= totalLines) {
          splitRow = Math.floor(totalLines / 2)
        }

        // Signature: first line(s) of the node up to and including the opening brace or colon
        // Scan up to first 5 lines for the opening brace/colon
        let sigLineCount = 1
        for (let si = 0; si < Math.min(5, totalLines); si++) {
          if (/[{:]/.test(partLines[si] ?? '')) {
            sigLineCount = si + 1
            break
          }
        }
        const signaturePrefix = partLines.slice(0, sigLineCount).join('\n')

        const part1 = partLines.slice(0, splitRow).join('\n')
        const part2Lines = partLines.slice(splitRow)
        const part2 = signaturePrefix + '\n' + part2Lines.join('\n')

        const symbolCont = symbol ? `${symbol} (cont.)` : undefined
        const h1 = header + ' part:1'
        const h2Parts = [
          `file:${file.path}`,
          symbolCont ? `symbol:${symbolCont}` : null,
          `kind:${kind}`,
          `lang:${file.lang}`,
          `lines:${startLine + splitRow}-${endLine}`,
          importsForFile.length > 0 ? `imports:${importsForFile.join(',')}` : null,
          'part:2',
        ].filter(Boolean) as string[]
        const h2 = h2Parts.join(' ')

        normalChunks.push({
          id: chunkId(file.path, symbol ? `${symbol}:1` : undefined, startLine),
          path: file.path, lang: file.lang, kind, symbol,
          startLine, endLine: startLine + splitRow - 1,
          header: h1, content: part1, hash: chunkHash(h1, part1),
        })
        normalChunks.push({
          id: chunkId(file.path, symbol ? `${symbol}:2` : undefined, startLine + splitRow),
          path: file.path, lang: file.lang, kind, symbol: symbolCont,
          startLine: startLine + splitRow, endLine,
          header: h2, content: part2, hash: chunkHash(h2, part2),
        })
        continue
      }

      const chunkObj: Chunk = {
        id: chunkId(file.path, symbol, startLine),
        path: file.path, lang: file.lang, kind, symbol,
        startLine, endLine,
        header, content, hash: chunkHash(header, content),
      }

      // merge tiny symbols into a single module-level chunk
      if (content.length < 150) {
        tinyChunks.push(chunkObj)
      } else {
        normalChunks.push(chunkObj)
      }
    }

    // merge contiguous tiny symbols into per-group module-level chunks
    if (tinyChunks.length > 0) {
      // Sort by startLine to ensure correct grouping
      tinyChunks.sort((a, b) => a.startLine - b.startLine)

      // Group into contiguous runs: adjacent if nextSymbol.startLine <= prevSymbol.endLine + 5
      const groups: Chunk[][] = []
      let currentGroup: Chunk[] = [tinyChunks[0]!]
      for (let i = 1; i < tinyChunks.length; i++) {
        const prev = currentGroup[currentGroup.length - 1]!
        const curr = tinyChunks[i]!
        if (curr.startLine <= prev.endLine + 5) {
          currentGroup.push(curr)
        } else {
          groups.push(currentGroup)
          currentGroup = [curr]
        }
      }
      groups.push(currentGroup)

      // Merge each contiguous group independently
      for (const group of groups) {
        const merged = group.map(c => c.content).join('\n\n')
        const firstInGroup = group[0]!
        const lastInGroup = group[group.length - 1]!
        const mergedHeader = `file:${file.path} kind:module lang:${file.lang} lines:${firstInGroup.startLine}-${lastInGroup.endLine}`
        normalChunks.push({
          id: chunkId(file.path, undefined, firstInGroup.startLine),
          path: file.path,
          lang: file.lang,
          kind: 'module',
          startLine: firstInGroup.startLine,
          endLine: lastInGroup.endLine,
          header: mergedHeader,
          content: merged,
          hash: chunkHash(mergedHeader, merged),
        })
      }
    }

    // if no symbols found, fall back to sliding window
    if (normalChunks.length === 0) return fallback.chunk(file)
    return normalChunks
  }
}
