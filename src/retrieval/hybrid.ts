import { rrf } from './rrf.js'
import { rerank } from './rerank.js'
import { expandChunks } from '../symbols/expand.js'
import { expandQuery } from './rewrite.js'
import type { Retriever, ScoredChunk, SearchFilter, Store, Embedder, SymbolIndex } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'

export class HybridRetriever implements Retriever {
  constructor(
    private store: Store,
    private embedder: Embedder,
    private kVector: number,
    private kFts: number,
    private symbolIndex?: SymbolIndex,
    private expandMaxTokens?: number,
    private expandDepth: number = 1,
    private config?: RagConfig,
  ) {}

  async retrieve(
    query: string,
    opts: { k: number; filter?: SearchFilter; expand?: boolean },
  ): Promise<ScoredChunk[]> {
    const [qVec] = await this.embedder.embed([query], 'query')
    if (!qVec) return []
    const [vectorResults, ftsResults] = await Promise.all([
      this.store.vectorSearch(qVec, this.kVector, opts.filter),
      this.store.textSearch(query, this.kFts, opts.filter),
    ])

    let rrfLists: ScoredChunk[][] = [vectorResults, ftsResults]

    // HyDE-lite: when rewrite is enabled, generate a hypothetical code snippet
    // and run an additional vector search with it, then fuse all three lists
    if (this.config?.retrieval.rewrite === true) {
      try {
        const hydeSnippet = await expandQuery(
          query,
          this.config.llm.model,
          this.config.llm.numCtx,
          this.config.llm.rewriteTemperature,
        )
        const [hydeVec] = await this.embedder.embed([hydeSnippet], 'query')
        if (hydeVec) {
          const hydeResults = await this.store.vectorSearch(hydeVec, this.kVector, opts.filter)
          rrfLists = [vectorResults, ftsResults, hydeResults]
        }
      } catch {
        // HyDE expansion is best-effort; fall through to standard 2-list fusion
      }
    }

    const fused = rrf(rrfLists)
    let top = fused.slice(0, opts.k)

    if (opts.expand && this.symbolIndex) {
      const maxTokens = this.expandMaxTokens ?? 4096
      top = await expandChunks(top, this.symbolIndex, this.store, maxTokens, this.expandDepth)
    }

    if (this.config && this.config.retrieval.rerank !== 'false') {
      top = await rerank(query, top, this.config)
    }

    return top
  }
}
