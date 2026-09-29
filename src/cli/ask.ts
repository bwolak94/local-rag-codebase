import { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { OllamaEmbedder } from '../embedding/ollama.js'
import { LanceDBStore } from '../store/lancedb.js'
import { HybridRetriever } from '../retrieval/hybrid.js'
import { OllamaGenerator } from '../generation/chat.js'
import { SQLiteSymbolIndex } from '../symbols/index.js'
import { allocateBudget } from '../generation/budget.js'

export function register(program: Command) {
  program
    .command('ask <question>')
    .description('Ask a single question about the codebase')
    .option('--k <n>', 'Number of context chunks', '8')
    .option('--path <prefix>', 'Restrict results to files under this path prefix')
    .option('--config <path>', 'Path to .ragconfig.json')
    .option('--expand', 'Expand context using symbol graph neighbors')
    .action(async (question: string, opts) => {
      const config = loadConfig({}, opts.config)
      const embedder = new OllamaEmbedder(config.embedding.model, config.embedding.batchSize)
      const store = new LanceDBStore(config.store.path, config.root, config.embedding.model)
      const symbolIndex = new SQLiteSymbolIndex(config.store.path, config.root)

      const { contextTokens } = allocateBudget(
        config.llm.numCtx,
        config.budget.contextFraction,
        config.budget.historyFraction,
      )

      const retriever = new HybridRetriever(
        store,
        embedder,
        config.retrieval.kVector,
        config.retrieval.kFts,
        symbolIndex,
        contextTokens,
        config.retrieval.expandDepth,
      )
      const generator = new OllamaGenerator(config)

      const k = parseInt(opts.k, 10)
      const filter = opts.path ? { pathPrefix: opts.path } : undefined
      const expand: boolean = opts.expand === true || config.retrieval.expandDepth > 0

      process.stdout.write('\n')
      const context = await retriever.retrieve(question, { k, filter, expand })
      const stream = generator.answer(question, context)

      for await (const token of stream) {
        process.stdout.write(token)
      }
      process.stdout.write('\n\n')

      if (context.length > 0) {
        console.log('Citations:')
        for (const { chunk } of context) {
          const sym = chunk.symbol ? ` (${chunk.symbol})` : ''
          console.log(`  - ${chunk.path}:${chunk.startLine}-${chunk.endLine}${sym}`)
        }
      }
    })
}
