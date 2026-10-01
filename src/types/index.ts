export type ChunkKind = 'function' | 'method' | 'class' | 'interface' | 'type' | 'module' | 'text'

export interface Chunk {
  id: string           // sha256(path + "|" + (symbol ?? "") + "|" + startLine).slice(0, 16)
  path: string         // relative to repo root
  lang: string
  kind: ChunkKind
  symbol?: string      // e.g. "InvoiceService.issue"
  startLine: number    // 1-indexed, inclusive
  endLine: number      // 1-indexed, inclusive
  header: string       // context header prepended before embedding
  content: string      // raw source text of the symbol
  hash: string         // sha256(header + content); used for incremental skip
}

export interface EmbeddedChunk extends Chunk {
  vector: number[]     // length === Embedder.dim
}

export interface SourceFile {
  path: string
  lang: string
  content: string
  hash: string         // sha256 of raw file bytes
}

export interface SearchFilter {
  pathPrefix?: string
  lang?: string[]
  kind?: ChunkKind[]
}

export interface ScoredChunk {
  chunk: Chunk
  score: number
  source: 'vector' | 'fts' | 'fused' | 'expanded'
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface SymbolDef {
  name: string
  kind: ChunkKind
  path: string
  startLine: number
  endLine: number
  chunkId: string
}

export interface SymbolRef {
  name: string
  path: string
  line: number
  chunkId: string
}

export interface Chunker {
  supports(file: SourceFile): boolean
  chunk(file: SourceFile): Promise<Chunk[]>
}

export interface Embedder {
  readonly model: string
  readonly dim: number
  embed(texts: string[], mode: 'document' | 'query'): Promise<number[][]>
}

export interface Store {
  upsert(chunks: EmbeddedChunk[]): Promise<void>
  deleteByPath(path: string): Promise<void>
  deleteByIds(ids: string[]): Promise<void>
  vectorSearch(vector: number[], k: number, filter?: SearchFilter): Promise<ScoredChunk[]>
  textSearch(query: string, k: number, filter?: SearchFilter): Promise<ScoredChunk[]>
  getMeta(): Promise<{ embedModel: string; dim: number } | null>
  getByIds(ids: string[]): Promise<ScoredChunk[]>
}

export interface SymbolIndex {
  upsert(defs: SymbolDef[], refs: SymbolRef[]): Promise<void>
  deleteByPath(path: string): Promise<void>
  definitions(name: string): Promise<SymbolDef[]>
  references(name: string): Promise<SymbolRef[]>
  neighbors(chunkId: string, depth?: number): Promise<string[]>
}

export interface Retriever {
  retrieve(
    query: string,
    opts: { k: number; filter?: SearchFilter; expand?: boolean }
  ): Promise<ScoredChunk[]>
}

export interface Generator {
  answer(
    question: string,
    context: ScoredChunk[],
    history?: ChatTurn[]
  ): AsyncIterable<string>
}
