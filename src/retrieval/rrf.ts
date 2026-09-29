import type { ScoredChunk } from '../types/index.js'

export function rrf(lists: ScoredChunk[][], k = 60): ScoredChunk[] {
  const acc = new Map<string, { chunk: import('../types/index.js').Chunk; score: number }>()

  for (const list of lists) {
    list.forEach((item, rank) => {
      const prev = acc.get(item.chunk.id)
      const s = 1 / (k + rank + 1)
      acc.set(item.chunk.id, {
        chunk: item.chunk,
        score: (prev?.score ?? 0) + s,
      })
    })
  }

  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ chunk, score }) => ({ chunk, score, source: 'fused' as const }))
}
