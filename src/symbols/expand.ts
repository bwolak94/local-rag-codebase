import { estimateTokens } from '../generation/budget.js'
import type { ScoredChunk, SymbolIndex, Store } from '../types/index.js'

export async function expandChunks(
  chunks: ScoredChunk[],
  symbolIndex: SymbolIndex,
  store: Store,
  maxTokens: number,
  depth = 1,
): Promise<ScoredChunk[]> {
  const seen = new Set(chunks.map(c => c.chunk.id))
  const result: ScoredChunk[] = [...chunks]
  let usedTokens = chunks.reduce(
    (sum, c) => sum + estimateTokens(c.chunk.content),
    0,
  )

  const neighborIds: string[] = []
  for (const { chunk } of chunks) {
    const ids = await symbolIndex.neighbors(chunk.id, depth)
    for (const id of ids) {
      if (!seen.has(id)) neighborIds.push(id)
    }
  }

  const uniqueNeighborIds = [...new Set(neighborIds)]
  const fetched = await store.getByIds(uniqueNeighborIds)

  for (const sc of fetched) {
    if (seen.has(sc.chunk.id)) continue
    const t = estimateTokens(sc.chunk.content)
    if (usedTokens + t > maxTokens) continue
    seen.add(sc.chunk.id)
    result.push({ ...sc, source: 'expanded' })
    usedTokens += t
  }

  return result
}
