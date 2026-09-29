import { describe, it, expect } from 'vitest'
import { allocateBudget, trimContext, trimHistory } from './budget.js'
import type { ScoredChunk, ChatTurn } from '../types/index.js'

const makeScored = (id: string, content: string, score: number): ScoredChunk => ({
  chunk: { id, path: 'a.ts', lang: 'ts', kind: 'function', startLine: 1, endLine: 5, header: '', content, hash: '' },
  score,
  source: 'vector',
})

describe('allocateBudget', () => {
  it('respects 60% context fraction', () => {
    const { contextTokens } = allocateBudget(32768, 0.60, 0.20)
    expect(contextTokens).toBe(Math.floor(32768 * 0.60))
  })
})

describe('trimContext', () => {
  it('drops lowest-scored chunks when over budget', () => {
    const chunks = [
      makeScored('a', 'x'.repeat(400), 0.9),
      makeScored('b', 'x'.repeat(400), 0.5),
      makeScored('c', 'x'.repeat(400), 0.1),
    ]
    // 400 chars / 4 = 100 tokens each, budget = 150 → only 1 fits
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
})
