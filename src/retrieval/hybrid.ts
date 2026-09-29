import { rrf } from './rrf.js'
import { expandChunks } from '../symbols/expand.js'
import type { Retriever, ScoredChunk, SearchFilter, Store, Embedder, SymbolIndex } from '../types/index.js'

export class HybridRetriever implements Retriever {
  constructor(
    private store: Store,
    private embedder: Embedder,
    private kVector: number,
    private kFts: number,
    private symbolIndex?: SymbolIndex,
    private expandMaxTokens?: number,
    private expandDepth: number = 1,
  ) {}

  async retrieve(
    query: string,
    opts: { k: number; filter?: SearchFilter; expand?: boolean },
  ): Promise<ScoredChunk[]> {
    const [qVec] = await this.embedder.embed([query], 'query')
    const [vectorResults, ftsResults] = await Promise.all([
      this.store.vectorSearch(qVec!, this.kVector, opts.filter),
      this.store.textSearch(query, this.kFts, opts.filter),
    ])

    const fused = rrf([vectorResults, ftsResults])
    const top = fused.slice(0, opts.k)

    if (opts.expand && this.symbolIndex) {
      const maxTokens = this.expandMaxTokens ?? 4096
      return expandChunks(top, this.symbolIndex, this.store, maxTokens, this.expandDepth)
    }

    return top
  }
}
