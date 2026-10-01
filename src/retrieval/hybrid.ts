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
    private opts: {
      kVector: number
      kFts: number
      symbolIndex?: SymbolIndex
      expandMaxTokens?: number
      expandDepth?: number
    },
    private config?: RagConfig,
  ) {}

  async retrieve(
    query: string,
    opts: { k: number; filter?: SearchFilter; expand?: boolean },
  ): Promise<ScoredChunk[]> {
    const effectiveQuery = query

    const [qVec] = await this.embedder.embed([effectiveQuery], 'query')
    if (!qVec) return []
    const [vectorResults, ftsResults] = await Promise.all([
      this.store.vectorSearch(qVec, this.opts.kVector, opts.filter),
      this.store.textSearch(effectiveQuery, this.opts.kFts, opts.filter),
    ])

    let rrfLists: ScoredChunk[][] = [vectorResults, ftsResults]

    // HyDE-lite: when rewrite is enabled, generate a hypothetical code snippet
    // and run an additional vector search with it, then fuse all three lists
    if (this.config?.retrieval.rewrite === true) {
      try {
        const hydeSnippet = await expandQuery(
          effectiveQuery,
          this.config.llm.model,
          this.config.llm.numCtx,
          this.config.retrieval.hydeTemperature,
          this.config.llm.host,
        )
        const [hydeVec] = await this.embedder.embed([hydeSnippet], 'document')
        if (hydeVec) {
          const hydeResults = await this.store.vectorSearch(hydeVec, this.opts.kVector, opts.filter)
          rrfLists = [vectorResults, ftsResults, hydeResults]
        }
      } catch {
        // HyDE expansion is best-effort; fall through to standard 2-list fusion
      }
    }

    const rrfK = this.config?.retrieval.rrfK ?? 60
    const fused = rrf(rrfLists, rrfK)
    let top = fused.slice(0, opts.k)

    if (opts.expand && this.opts.symbolIndex) {
      const maxTokens = this.opts.expandMaxTokens ?? 4096
      const expandDepth = this.opts.expandDepth ?? 1
      top = await expandChunks(top, this.opts.symbolIndex, this.store, maxTokens, expandDepth)
    }

    if (this.config && this.config.retrieval.rerank !== 'none') {
      top = await rerank(effectiveQuery, top, this.config)
    }

    return top
  }
}
