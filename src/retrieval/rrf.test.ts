import { describe, it, expect } from 'vitest'
import { rrf } from './rrf.js'
import type { ScoredChunk } from '../types/index.js'

const makeChunk = (id: string): ScoredChunk => ({
  chunk: { id, path: 'a.ts', lang: 'typescript', kind: 'function', startLine: 1, endLine: 10, header: '', content: '', hash: '' },
  score: 1,
  source: 'vector',
})

describe('rrf', () => {
  it('returns [] for empty input', () => {
    expect(rrf([])).toEqual([])
  })

  it('single list passes through with fused source', () => {
    const list = [makeChunk('a'), makeChunk('b')]
    const result = rrf([list])
    expect(result.map(r => r.chunk.id)).toEqual(['a', 'b'])
    expect(result[0]?.source).toBe('fused')
  })

  it('promotes docs appearing in both lists', () => {
    const listA = [makeChunk('a'), makeChunk('b'), makeChunk('c')]
    const listB = [makeChunk('b'), makeChunk('d')]
    const result = rrf([listA, listB])
    expect(result[0]?.chunk.id).toBe('b') // b in both lists → highest score
  })

  it('k=60 formula: rank 0 score = 1/61', () => {
    const list = [makeChunk('x')]
    const result = rrf([list], 60)
    expect(result[0]?.score).toBeCloseTo(1 / 61)
  })

  it('rrf handles empty sublists within multi-list input', () => {
    const item = makeChunk('a')
    const result = rrf([[], [item]])
    expect(result).toHaveLength(1)
    expect(result[0]?.chunk.id).toBe('a')
    // With k=60 and rank=0 (from the second list), score should be 1/61
    expect(result[0]?.score).toBeCloseTo(1 / 61)
  })

  it('rrf with k=30 produces different scores than k=60', () => {
    const listA = [makeChunk('x'), makeChunk('y')]
    const listB = [makeChunk('x')]

    const resultK30 = rrf([listA, listB], 30)
    const resultK60 = rrf([listA, listB], 60)

    const itemK30 = resultK30.find(r => r.chunk.id === 'x')
    const itemK60 = resultK60.find(r => r.chunk.id === 'x')

    expect(itemK30).toBeDefined()
    expect(itemK60).toBeDefined()
    // k=30: 1/(30+0+1) + 1/(30+0+1) = 2/31 ≈ 0.0645
    // k=60: 1/(60+0+1) + 1/(60+0+1) = 2/61 ≈ 0.0328
    expect(itemK30!.score).not.toEqual(itemK60!.score)
    expect(itemK30!.score).toBeGreaterThan(itemK60!.score)
  })

  it('rrf gives equal-rank items deterministic ordering', () => {
    // Two items both at rank 0 in separate lists
    const listA = [makeChunk('a'), makeChunk('b')]
    const listB = [makeChunk('c'), makeChunk('d')]

    const result = rrf([listA, listB])
    const ids = result.map(r => r.chunk.id)

    // Both a and c have the same score (1/61 each)
    // They should both be in the output
    expect(ids).toContain('a')
    expect(ids).toContain('c')
    expect(ids).toHaveLength(4)
  })

  it('rrf with three items at equal rank across lists', () => {
    // Three items each at rank 0 in separate lists
    const listA = [makeChunk('x')]
    const listB = [makeChunk('y')]
    const listC = [makeChunk('z')]

    const result = rrf([listA, listB, listC])
    const ids = result.map(r => r.chunk.id)

    // All three should appear with equal scores (1/61 each)
    expect(ids).toContain('x')
    expect(ids).toContain('y')
    expect(ids).toContain('z')
    expect(ids).toHaveLength(3)

    // All should have the same score
    const scores = result.map(r => r.score)
    expect(scores[0]).toBeCloseTo(scores[1]!)
    expect(scores[1]).toBeCloseTo(scores[2]!)
  })
})
