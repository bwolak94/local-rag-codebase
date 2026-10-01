import { describe, it, expect } from 'vitest'
import { allocateBudget, trimContext, trimHistory } from './budget.js'
import type { ScoredChunk, ChatTurn } from '../types/index.js'

const makeScored = (id: string, content: string, score: number): ScoredChunk => ({
  chunk: { id, path: 'a.ts', lang: 'ts', kind: 'function', startLine: 1, endLine: 5, header: '', content, hash: '' },
  score,
  source: 'vector',
})

describe('allocateBudget', () => {
  it('respects 60% context fraction and 20% history fraction', () => {
    // SYSTEM_PROMPT_OVERHEAD = 600 is subtracted before applying fractions
    const { contextTokens, historyTokens } = allocateBudget(32768, 0.60, 0.20)
    expect(contextTokens).toBe(Math.floor((32768 - 600) * 0.60))
    expect(historyTokens).toBe(Math.floor((32768 - 600) * 0.20))
  })
})

describe('trimContext', () => {
  it('drops lowest-scored chunks when over budget', () => {
    const chunks = [
      makeScored('a', 'x'.repeat(400), 0.9),
      makeScored('b', 'x'.repeat(400), 0.5),
      makeScored('c', 'x'.repeat(400), 0.1),
    ]
    // 400 chars / 2.5 ≈ 160 tokens + 90 overhead = 250 tokens each, budget = 150 → only 1 fits
    const result = trimContext(chunks, 150)
    expect(result).toHaveLength(1)
    expect(result[0]?.chunk.id).toBe('a')
  })
})

describe('trimHistory', () => {
  it('drops oldest turns first', () => {
    const history: ChatTurn[] = [
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'assistant', content: 'x'.repeat(400) },
      { role: 'user', content: 'recent' },
    ]
    const result = trimHistory(history, 50)
    expect(result[result.length - 1]?.content).toBe('recent')
  })

  it('returns empty array when the last turn alone exceeds budget', () => {
    // trimHistory breaks before including a turn that pushes over the limit,
    // even for the most recent turn — no first-always-included guarantee here.
    const history: ChatTurn[] = [
      { role: 'user', content: 'x'.repeat(10000) },
    ]
    const result = trimHistory(history, 1)
    expect(result).toHaveLength(0)
  })
})

describe('trimContext edge cases', () => {
  it('includes single oversized chunk even if it exceeds budget', () => {
    const bigChunk = makeScored('big', 'x'.repeat(10000), 1)
    // budget = 10 tokens, chunk is way bigger — but first chunk is always included
    const result = trimContext([bigChunk], 10)
    expect(result).toHaveLength(1) // first chunk always included
  })
})

describe('allocateBudget edge cases', () => {
  it('allocateBudget with zero numCtx does not throw', () => {
    expect(() => allocateBudget(0, 0.6, 0.2)).not.toThrow()
    const { contextTokens, historyTokens } = allocateBudget(0, 0.6, 0.2)
    expect(contextTokens).toBe(0)
    expect(historyTokens).toBe(0)
  })

  it('allocateBudget with very small numCtx (less than overhead) returns zeros', () => {
    // SYSTEM_PROMPT_OVERHEAD is 600; numCtx=100 → available = max(0, 100-600) = 0
    const { contextTokens, historyTokens } = allocateBudget(100, 0.6, 0.2)
    expect(contextTokens).toBe(0)
    expect(historyTokens).toBe(0)
  })
})
