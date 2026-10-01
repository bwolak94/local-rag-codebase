import type { ScoredChunk, ChatTurn } from '../types/index.js'

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5)
}

const SYSTEM_PROMPT_OVERHEAD = 600

export function allocateBudget(
  numCtx: number,
  contextFraction: number,
  historyFraction: number,
): { contextTokens: number; historyTokens: number } {
  const available = Math.max(0, numCtx - SYSTEM_PROMPT_OVERHEAD)
  return {
    contextTokens: Math.floor(available * contextFraction),
    historyTokens: Math.floor(available * historyFraction),
  }
}

export function trimContext(chunks: ScoredChunk[], maxTokens: number): ScoredChunk[] {
  let used = 0
  const result: ScoredChunk[] = []
  // sort by score descending, keep highest-scored chunks first
  const sorted = [...chunks].sort((a, b) => b.score - a.score)
  for (const c of sorted) {
    const t = estimateTokens(c.chunk.header + '\n' + c.chunk.content) + 90
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
