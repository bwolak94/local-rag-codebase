import type { ScoredChunk, ChatTurn } from '../types/index.js'

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

export function allocateBudget(
  numCtx: number,
  contextFraction: number,
  historyFraction: number,
): { contextTokens: number; historyTokens: number } {
  return {
    contextTokens: Math.floor(numCtx * contextFraction),
    historyTokens: Math.floor(numCtx * historyFraction),
  }
}

export function trimContext(chunks: ScoredChunk[], maxTokens: number): ScoredChunk[] {
  let used = 0
  const result: ScoredChunk[] = []
  // sort by score descending, keep highest-scored chunks first
  const sorted = [...chunks].sort((a, b) => b.score - a.score)
  for (const c of sorted) {
    // 400 chars / 3.5 ≈ 114 tokens
    const t = estimateTokens(c.chunk.header + c.chunk.content)
    if (result.length > 0 && used + t > maxTokens) break
    result.push(c)
    used += t
  }
  result.sort((a, b) => a.chunk.path < b.chunk.path ? -1 : a.chunk.path > b.chunk.path ? 1 : a.chunk.startLine - b.chunk.startLine)
  return result
}

export function trimHistory(history: ChatTurn[], maxTokens: number): ChatTurn[] {
  let used = 0
  const result: ChatTurn[] = []
  // keep most recent turns
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i]
    if (turn === undefined) continue
    const t = estimateTokens(turn.content)
    if (used + t > maxTokens) break
    result.unshift(turn)
    used += t
  }
  return result
}
