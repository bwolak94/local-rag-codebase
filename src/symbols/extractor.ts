import Parser from 'web-tree-sitter'
import { getParser } from '../chunking/treesitter.js'
import { chunkId as makeChunkId } from '../ingest/hasher.js'
import type { SymbolDef, SymbolRef, ChunkKind, SourceFile, Chunk } from '../types/index.js'

export interface ExtractionResult {
  defs: SymbolDef[]
  refs: SymbolRef[]
}

const SUPPORTED_LANGS = new Set(['typescript', 'tsx', 'javascript'])

// Node types that represent symbol definitions
const DEF_NODE_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'class_declaration',
  'interface_declaration',
  'type_alias_declaration',
])

// Node types that are parent containers for actual references (usages), not bindings.
// variable_declarator is intentionally excluded — it captures the binding name (LHS),
// not a reference to another symbol.
const REF_PARENT_TYPES = new Set([
  'call_expression',
  'type_reference',
])

function kindFromNodeType(type: string): ChunkKind {
  if (type.includes('function')) return 'function'
  if (type.includes('method')) return 'method'
  if (type.includes('class')) return 'class'
  if (type.includes('interface')) return 'interface'
  if (type.includes('type_alias')) return 'type'
  return 'module'
}

/**
 * Find the chunk that contains the given line range by overlap.
 * Falls back to a synthetic chunkId if no chunk covers the position.
 */
function findChunkId(
  chunks: Chunk[],
  filePath: string,
  startLine: number,
  fallbackSymbol?: string,
): string {
  const match = chunks.find(c => c.startLine <= startLine && c.endLine >= startLine)
  return match?.id ?? makeChunkId(filePath, fallbackSymbol, startLine)
}

/**
 * Recursively walks the AST and collects definition and reference nodes.
 * Definitions are collected when a node type is a known declaration.
 * References are collected for identifier nodes inside call expressions and
 * type references — nodes that represent actual usages of other symbols.
 *
 * The chunks array (produced by the chunker for this file) is used to map
 * each def/ref to the correct chunk ID by line overlap rather than
 * recomputing the ID formula, which would diverge for split chunks.
 */
function walk(
  node: Parser.SyntaxNode,
  file: SourceFile,
  chunks: Chunk[],
  defs: SymbolDef[],
  refs: SymbolRef[],
): void {
  if (DEF_NODE_TYPES.has(node.type)) {
    // Try to find the name child — typically a child named "name"
    const nameNode = node.childForFieldName('name')
    if (nameNode) {
      const name = nameNode.text
      const startLine = node.startPosition.row + 1
      const endLine = node.endPosition.row + 1
      // Use actual chunk ID from the chunks array to handle split symbols correctly.
      const chunkId = findChunkId(chunks, file.path, startLine, name)
      defs.push({
        name,
        kind: kindFromNodeType(node.type),
        path: file.path,
        startLine,
        endLine,
        chunkId,
      })
    }
  }

  if (REF_PARENT_TYPES.has(node.type)) {
    // For call_expression: the function being called is the first child (identifier or member access)
    // For type_reference: the first named child is the identifier
    let identNode: Parser.SyntaxNode | null = null

    if (node.type === 'call_expression') {
      identNode = node.firstNamedChild
      // skip member expressions — we only want simple identifier calls
      if (identNode && identNode.type !== 'identifier') {
        identNode = null
      }
    } else if (node.type === 'type_reference') {
      identNode = node.firstNamedChild
      if (identNode && identNode.type !== 'type_identifier' && identNode.type !== 'identifier') {
        identNode = null
      }
    }

    if (identNode) {
      const name = identNode.text
      const line = identNode.startPosition.row + 1
      // Use the enclosing chunk's ID, not a chunk ID derived from the ref's own line.
      // A call on line 42 inside a function starting at line 10 must use the
      // enclosing chunk's ID so neighbors() can locate it correctly.
      const chunkId = findChunkId(chunks, file.path, line)
      refs.push({ name, path: file.path, line, chunkId })
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child) {
      walk(child, file, chunks, defs, refs)
    }
  }
}

export async function extractSymbols(
  file: SourceFile,
  tree: Parser.Tree,
  chunks: Chunk[] = [],
): Promise<ExtractionResult> {
  if (!SUPPORTED_LANGS.has(file.lang)) {
    return { defs: [], refs: [] }
  }

  try {
    const defs: SymbolDef[] = []
    const refs: SymbolRef[] = []
    walk(tree.rootNode, file, chunks, defs, refs)
    return { defs, refs }
  } catch {
    return { defs: [], refs: [] }
  }
}

// Re-export getParser so callers can reuse it
export { getParser }
