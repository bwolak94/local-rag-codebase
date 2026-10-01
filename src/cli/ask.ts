import { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { createEmbedder } from '../embedding/factory.js'
import { createStore } from '../store/factory.js'
import { HybridRetriever } from '../retrieval/hybrid.js'
import { OllamaGenerator } from '../generation/chat.js'
import { SQLiteSymbolIndex } from '../symbols/index.js'
import { allocateBudget } from '../generation/budget.js'
import { agentLoop } from '../agent/loop.js'
import type { ToolContext } from '../agent/tools.js'

export function register(program: Command) {
  program
    .command('ask <question>')
    .description('Ask a single question about the codebase')
    .option('--k <n>', 'Number of context chunks', '8')
    .option('--path <prefix>', 'Restrict results to files under this path prefix')
    .option('--config <path>', 'Path to .ragconfig.json')
    .option('--expand', 'Expand context using symbol graph neighbors')
    .option('--agent', 'Use agent loop with tool calling instead of single-shot retrieval')
    .action(async (question: string, opts) => {
      const config = loadConfig({}, opts.config)
      const embedder = createEmbedder(config)
      const store = createStore(config)
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
        config,
      )

      if (opts.agent) {
        const toolCtx: ToolContext = { retriever, symbolIndex, root: config.root }
        const result = await agentLoop(question, toolCtx, config, [], config.llm.host)
        process.stdout.write('\n' + result.answer + '\n\n')
        console.log(`[agent] completed in ${result.steps} steps — tools: ${result.toolsUsed.join(', ') || 'none'}`)
      } else {
        const generator = new OllamaGenerator(config, config.llm.host)

        const k = parseInt(opts.k as string, 10)
        if (isNaN(k) || k < 1) {
          console.error('--k must be a positive integer')
          process.exit(1)
        }
        const filter = opts.path ? { pathPrefix: opts.path } : undefined
        // --expand is opt-in; config.retrieval.expandDepth > 0 acts as config-level default
        const expand: boolean = opts.expand !== undefined ? opts.expand === true : config.retrieval.expandDepth > 0

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
      }
    })
}
