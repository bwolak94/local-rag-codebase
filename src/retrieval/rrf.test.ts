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
})
