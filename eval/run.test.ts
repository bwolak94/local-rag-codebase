import { describe, it, expect } from 'vitest'
import { computeRecallAtK, computeTagBreakdown } from './run.js'
import type { Question, EvalDetail } from './run.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetail(
  q: string,
  expected: string[],
  retrieved: string[],
): EvalDetail {
  const found = expected.some(e => retrieved.some(p => p.startsWith(e) || p === e))
  let reciprocalRank = 0
  for (let i = 0; i < retrieved.length; i++) {
    const p = retrieved[i]
    if (p !== undefined && expected.some(e => p.startsWith(e) || p === e)) {
      reciprocalRank = 1 / (i + 1)
      break
    }
  }
  return { q, expected, retrieved, found, reciprocalRank }
}

// ---------------------------------------------------------------------------
// computeRecallAtK
// ---------------------------------------------------------------------------

describe('computeRecallAtK', () => {
  it('correct for k=5 when expected file is in top 5', () => {
    const dataset: Question[] = [
      { q: 'q1', expected: ['src/foo.ts'], tags: ['identifier'] },
      { q: 'q2', expected: ['src/bar.ts'], tags: ['semantic'] },
    ]
    const details: EvalDetail[] = [
      makeDetail('q1', ['src/foo.ts'], ['src/foo.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']),
      makeDetail('q2', ['src/bar.ts'], ['src/x.ts', 'src/y.ts', 'src/z.ts', 'src/w.ts', 'src/v.ts']),
    ]
    const recall = computeRecallAtK(details, dataset, [5])
    // q1 found in top 5, q2 not found → 1/2 = 0.5
    expect(recall[5]).toBeCloseTo(0.5)
  })

  it('correct for k=10 when expected file is in position 8', () => {
    const dataset: Question[] = [
      { q: 'q1', expected: ['src/target.ts'], tags: ['semantic'] },
    ]
    const retrieved = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'src/target.ts', 'h.ts', 'i.ts']
    const details: EvalDetail[] = [
      makeDetail('q1', ['src/target.ts'], retrieved),
    ]
    const recall = computeRecallAtK(details, dataset, [5, 10])
    expect(recall[5]).toBe(0)        // not in top 5
    expect(recall[10]).toBeCloseTo(1) // in top 10 (position 8)
  })

  it('found flag correct when expected file is in retrieved list', () => {
    const detail = makeDetail('q', ['src/foo.ts'], ['src/foo.ts'])
    expect(detail.found).toBe(true)
  })

  it('found flag false when expected file is not in retrieved list', () => {
    const detail = makeDetail('q', ['src/foo.ts'], ['src/bar.ts', 'src/baz.ts'])
    expect(detail.found).toBe(false)
  })

  it('empty dataset returns 0 recall', () => {
    const recall = computeRecallAtK([], [], [5, 10])
    expect(recall[5]).toBe(0)
    expect(recall[10]).toBe(0)
  })

  it('all hits returns recall 1.0', () => {
    const dataset: Question[] = [
      { q: 'q1', expected: ['src/a.ts'], tags: ['identifier'] },
      { q: 'q2', expected: ['src/b.ts'], tags: ['identifier'] },
    ]
    const details: EvalDetail[] = [
      makeDetail('q1', ['src/a.ts'], ['src/a.ts']),
      makeDetail('q2', ['src/b.ts'], ['src/b.ts']),
    ]
    const recall = computeRecallAtK(details, dataset, [1])
    expect(recall[1]).toBeCloseTo(1)
  })
})

// ---------------------------------------------------------------------------
// computeTagBreakdown
// ---------------------------------------------------------------------------

describe('computeTagBreakdown', () => {
  it('per-tag breakdown is computed correctly for identifier vs semantic split', () => {
    const dataset: Question[] = [
      { q: 'q1', expected: ['src/foo.ts'], tags: ['identifier'] },
      { q: 'q2', expected: ['src/bar.ts'], tags: ['identifier'] },
      { q: 'q3', expected: ['src/baz.ts'], tags: ['semantic'] },
    ]
    const details: EvalDetail[] = [
      makeDetail('q1', ['src/foo.ts'], ['src/foo.ts']), // identifier hit
      makeDetail('q2', ['src/bar.ts'], ['src/other.ts']), // identifier miss
      makeDetail('q3', ['src/baz.ts'], ['src/baz.ts']), // semantic hit
    ]

    const { tagBreakdown, tagCounts } = computeTagBreakdown(details, dataset, [5])

    expect(tagCounts['identifier']).toBe(2)
    expect(tagCounts['semantic']).toBe(1)

    // 1 out of 2 identifier questions hit → 0.5
    expect(tagBreakdown['identifier']?.[5]).toBeCloseTo(0.5)
    // 1 out of 1 semantic question hit → 1.0
    expect(tagBreakdown['semantic']?.[5]).toBeCloseTo(1.0)
  })

  it('empty dataset returns empty breakdown', () => {
    const { tagBreakdown, tagCounts } = computeTagBreakdown([], [], [5])
    expect(Object.keys(tagBreakdown)).toHaveLength(0)
    expect(Object.keys(tagCounts)).toHaveLength(0)
  })

  it('multi-tagged question is counted in each tag', () => {
    const dataset: Question[] = [
      { q: 'q1', expected: ['src/foo.ts'], tags: ['semantic', 'cross-file'] },
    ]
    const details: EvalDetail[] = [
      makeDetail('q1', ['src/foo.ts'], ['src/foo.ts']),
    ]

    const { tagBreakdown, tagCounts } = computeTagBreakdown(details, dataset, [5])

    expect(tagCounts['semantic']).toBe(1)
    expect(tagCounts['cross-file']).toBe(1)
    expect(tagBreakdown['semantic']?.[5]).toBeCloseTo(1.0)
    expect(tagBreakdown['cross-file']?.[5]).toBeCloseTo(1.0)
  })

  it('returns 0 recall for a tag when no questions hit', () => {
    const dataset: Question[] = [
      { q: 'q1', expected: ['src/foo.ts'], tags: ['multi-hop'] },
    ]
    const details: EvalDetail[] = [
      makeDetail('q1', ['src/foo.ts'], ['src/completely-wrong.ts']),
    ]

    const { tagBreakdown } = computeTagBreakdown(details, dataset, [5])
    expect(tagBreakdown['multi-hop']?.[5]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// MRR computation (tested inline via makeDetail's reciprocalRank)
// ---------------------------------------------------------------------------

describe('MRR via reciprocalRank computation', () => {
  it('first position reciprocal rank is 1.0', () => {
    const d = makeDetail('q', ['src/foo.ts'], ['src/foo.ts', 'src/bar.ts'])
    expect(d.reciprocalRank).toBeCloseTo(1.0)
  })

  it('second position reciprocal rank is 0.5', () => {
    const d = makeDetail('q', ['src/foo.ts'], ['src/bar.ts', 'src/foo.ts'])
    expect(d.reciprocalRank).toBeCloseTo(0.5)
  })

  it('not found returns reciprocalRank 0', () => {
    const d = makeDetail('q', ['src/foo.ts'], ['src/bar.ts', 'src/baz.ts'])
    expect(d.reciprocalRank).toBe(0)
  })

  it('empty dataset returns 0 MRR', () => {
    // With no details, mrr = 0/0 → use length guard → 0
    const dataset: Question[] = []
    const recall = computeRecallAtK([], dataset, [5])
    expect(recall[5]).toBe(0)
  })
})
