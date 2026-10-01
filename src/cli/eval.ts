import { Command } from 'commander'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadConfig } from '../config/loader.js'
import { OllamaEmbedder } from '../embedding/ollama.js'
import { LanceDBStore } from '../store/lancedb.js'
import { HybridRetriever } from '../retrieval/hybrid.js'
import {
  computeRecallAtK,
  computeTagBreakdown,
  type Question,
  type EvalDetail,
  type EvalResult,
} from '../../eval/run.js'

export function register(program: Command): void {
  program
    .command('eval')
    .description('Run retrieval evaluation against a JSONL dataset')
    .option('--dataset <path>', 'Path to evaluation dataset JSONL', 'eval/dataset.jsonl')
    .option('--k <values>', 'Comma-separated k values to evaluate', '5,10')
    .option('--config <path>', 'Path to .ragconfig.json')
    .action(async (opts) => {
      const config = loadConfig({}, opts.config)

      const kValues: number[] = (opts.k as string)
        .split(',')
        .map(Number)
        .filter(Number.isFinite)

      if (kValues.length === 0) {
        console.error('[eval] --k must be a comma-separated list of positive integers (e.g. 5,10)')
        process.exit(1)
      }

      const embedder = new OllamaEmbedder(config.embedding.model, config.embedding.batchSize)
      const store = new LanceDBStore(config.store.path, config.root, config.embedding.model)
      const retriever = new HybridRetriever(
        store,
        embedder,
        {
          kVector: config.retrieval.kVector,
          kFts: config.retrieval.kFts,
          expandDepth: config.retrieval.expandDepth,
        },
        config,
      )

      const datasetPath = resolve(process.cwd(), opts.dataset as string)
      const dataset: Question[] = readFileSync(datasetPath, 'utf8')
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
        const slicedPaths = retrievedPaths.slice(0, maxK)

        let reciprocalRank = 0
        for (let i = 0; i < slicedPaths.length; i++) {
          const p = slicedPaths[i]
          if (p !== undefined && item.expected.some(e => p.startsWith(e) || p === e)) {
            reciprocalRank = 1 / (i + 1)
            break
          }
        }
        mrrSum += reciprocalRank

        const found = item.expected.some(e => slicedPaths.some(p => p.startsWith(e) || p === e))
        details.push({
          q: item.q,
          expected: item.expected,
          retrieved: slicedPaths,
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
      console.log(`MRR@${maxK}:       ${mrr.toFixed(2)}`)

      const { tagBreakdown, tagCounts } = computeTagBreakdown(details, dataset, kValues)
      console.log('\nPer-tag breakdown:')
      for (const [tag, kMap] of Object.entries(tagBreakdown)) {
        for (const k of kValues) {
          const score = kMap[k] ?? 0
          console.log(`  [${tag}] Recall@${k}: ${score.toFixed(2)} (${tagCounts[tag] ?? 0} questions)`)
        }
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)
      const outDir = resolve(process.cwd(), 'eval/results')
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
    })
}
