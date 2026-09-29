import { rrf } from './rrf.js'
import type { Retriever, ScoredChunk, SearchFilter, Store, Embedder } from '../types/index.js'

export class HybridRetriever implements Retriever {
  constructor(
    private store: Store,
    private embedder: Embedder,
    private kVector: number,
    private kFts: number,
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
    return fused.slice(0, opts.k)
  }
}
