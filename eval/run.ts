import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config/loader.js'
import { OllamaEmbedder } from '../src/embedding/ollama.js'
import { LanceDBStore } from '../src/store/lancedb.js'
import { HybridRetriever } from '../src/retrieval/hybrid.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface Question {
  q: string
  expected: string[]
  tags: string[]
}

export interface EvalDetail {
  q: string
  expected: string[]
  retrieved: string[]
  found: boolean
  reciprocalRank: number
}

export interface EvalResult {
  timestamp: string
  kValues: number[]
  recallAtK: Record<number, number>
  mrr: number
  totalQuestions: number
  tagBreakdown: Record<string, Record<number, number>>
  details: EvalDetail[]
}

export function computeRecallAtK(
  details: EvalDetail[],
  dataset: Question[],
  kValues: number[],
): Record<number, number> {
  const recallAtK: Record<number, number> = {}
  for (const k of kValues) {
    const hits = details.filter(d => {
      const topK = d.retrieved.slice(0, k)
      return d.expected.some(e => topK.some(p => p.startsWith(e) || p === e))
    }).length
    recallAtK[k] = dataset.length === 0 ? 0 : hits / dataset.length
  }
  return recallAtK
}

export function computeTagBreakdown(
  details: EvalDetail[],
  dataset: Question[],
  kValues: number[],
): { tagBreakdown: Record<string, Record<number, number>>; tagCounts: Record<string, number> } {
  const tagCounts: Record<string, number> = {}
  for (const item of dataset) {
    for (const tag of item.tags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1
    }
  }

  const tagBreakdown: Record<string, Record<number, number>> = {}
  for (const k of kValues) {
    for (const tag of Object.keys(tagCounts)) {
      const tagQuestions = dataset.filter(q => q.tags.includes(tag))
      const tagHits = tagQuestions.filter(q => {
        const d = details.find(d => d.q === q.q)
        if (!d) return false
        const topK = d.retrieved.slice(0, k)
        return q.expected.some(e => topK.some(p => p.startsWith(e) || p === e))
      }).length
      if (!tagBreakdown[tag]) tagBreakdown[tag] = {}
      tagBreakdown[tag][k] = tagQuestions.length === 0 ? 0 : tagHits / tagQuestions.length
    }
  }

  return { tagBreakdown, tagCounts }
}

async function main() {
  const kArg = process.argv.find(a => a.startsWith('--k='))
  const kValues = kArg
    ? kArg.replace('--k=', '').split(',').map(Number)
    : [5, 10]

  const fullEval = process.argv.includes('--full')

  const config = loadConfig()
  const embedder = new OllamaEmbedder(config.embedding.model, config.embedding.batchSize)
  const store = new LanceDBStore(config.store.path, config.root, config.embedding.model)
  const retriever = new HybridRetriever(store, embedder, config.retrieval.kVector, config.retrieval.kFts)

  const dataset: Question[] = readFileSync(resolve(__dirname, 'dataset.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Question)

  const maxK = Math.max(...kValues, 1)
  const details: EvalDetail[] = []
  let mrrSum = 0

  for (const item of dataset) {
    const results = await retriever.retrieve(item.q, { k: maxK })
    const retrievedPaths = results.map(r => r.chunk.path)

    let reciprocalRank = 0
    for (let i = 0; i < retrievedPaths.length; i++) {
      const p = retrievedPaths[i]
      if (p !== undefined && item.expected.some(e => p.startsWith(e) || p === e)) {
        reciprocalRank = 1 / (i + 1)
        break
      }
    }
    mrrSum += reciprocalRank

    const found = item.expected.some(e => retrievedPaths.some(p => p.startsWith(e) || p === e))
    details.push({
      q: item.q,
      expected: item.expected,
      retrieved: retrievedPaths,   // full list, not .slice(0, maxK)
      found,
      reciprocalRank,
    })
  }

  const recallAtK = computeRecallAtK(details, dataset, kValues)
  const mrr = dataset.length === 0 ? 0 : mrrSum / dataset.length

  for (const k of kValues) {
    const recall = recallAtK[k] ?? 0
    const pct = (recall * 100).toFixed(1)
    console.log(
      `Recall@${k}:  ${recall.toFixed(2)} (${pct}% — ${Math.round(recall * dataset.length)}/${dataset.length} questions)`,
    )
  }
  console.log(`MRR:       ${mrr.toFixed(2)}`)

  // Per-tag breakdown
  const { tagBreakdown, tagCounts } = computeTagBreakdown(details, dataset, kValues)
  console.log('\nPer-tag breakdown:')
  for (const [tag, kMap] of Object.entries(tagBreakdown)) {
    for (const k of kValues) {
      const score = kMap[k] ?? 0
      console.log(`  [${tag}] Recall@${k}: ${score.toFixed(2)} (${tagCounts[tag] ?? 0} questions)`)
    }
  }

  // Faithfulness evaluation (--full flag)
  if (fullEval) {
    console.log('\nFaithfulness evaluation (--full):')
    console.log('  Note: offline faithfulness eval requires generated answers.')
    console.log('  To run faithfulness evaluation:')
    console.log('    1. Run `rag ask "<question>"` for each question to generate answers')
    console.log('    2. Collect answers alongside retrieved context')
    console.log('    3. Use an LLM judge to score groundedness (0.0-1.0) per question')
    console.log('  This offline harness only has retrieved file paths, not generated answer text.')
    console.log('  Faithfulness: N/A (requires online eval with generated answers)')
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
  const outDir = resolve(__dirname, 'results')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, `${timestamp}.json`)

  const result: EvalResult = {
    timestamp: new Date().toISOString(),
    kValues,
    recallAtK,
    mrr,
    totalQuestions: dataset.length,
    tagBreakdown,
    details,
  }

  writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`\nResults written to: eval/results/${timestamp}.json`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
