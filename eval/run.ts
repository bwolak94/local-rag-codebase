import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config/loader.js'
import { OllamaEmbedder } from '../src/embedding/ollama.js'
import { LanceDBStore } from '../src/store/lancedb.js'
import { HybridRetriever } from '../src/retrieval/hybrid.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface Question {
  q: string
  expected: string[]
  tags: string[]
}

interface EvalResult {
  timestamp: string
  kValues: number[]
  recallAtK: Record<number, number>
  mrr: number
  totalQuestions: number
  details: Array<{
    q: string
    expected: string[]
    retrieved: string[]
    found: boolean
    reciprocalRank: number
  }>
}

async function main() {
  const kArg = process.argv.find(a => a.startsWith('--k='))
  const kValues = kArg
    ? kArg.replace('--k=', '').split(',').map(Number)
    : [5, 10]

  const config = loadConfig()
  const embedder = new OllamaEmbedder(config.embedding.model, config.embedding.batchSize)
  const store = new LanceDBStore(config.store.path, config.root, config.embedding.model)
  const retriever = new HybridRetriever(store, embedder, config.retrieval.kVector, config.retrieval.kFts)

  const dataset: Question[] = readFileSync(resolve(__dirname, 'dataset.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Question)

  const maxK = Math.max(...kValues)
  const details: EvalResult['details'] = []
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
      retrieved: retrievedPaths,   // full list, not .slice(0, 5)
      found,
      reciprocalRank,
    })
  }

  const recallAtK: Record<number, number> = {}
  for (const k of kValues) {
    const hits = details.filter(d => {
      const topK = d.retrieved.slice(0, k)
      return d.expected.some(e => topK.some(p => p.startsWith(e) || p === e))
    }).length
    recallAtK[k] = hits / dataset.length
  }

  const mrr = mrrSum / dataset.length

  for (const k of kValues) {
    const recall = recallAtK[k] ?? 0
    const pct = (recall * 100).toFixed(1)
    console.log(
      `Recall@${k}:  ${recall.toFixed(2)} (${pct}% — ${Math.round(recall * dataset.length)}/${dataset.length} questions)`,
    )
  }
  console.log(`MRR:       ${mrr.toFixed(2)}`)

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
    details,
  }

  writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`\nResults written to: eval/results/${timestamp}.json`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
