import { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { createEmbedder } from '../embedding/factory.js'
import { createStore } from '../store/factory.js'
import { SQLiteSymbolIndex } from '../symbols/index.js'
import { HybridRetriever } from '../retrieval/hybrid.js'
import { startMCPServer } from '../mcp/server.js'
import { allocateBudget } from '../generation/budget.js'

export function register(program: Command) {
  program
    .command('serve-mcp')
    .description('Start the MCP server over stdio for use with Claude Code / Cursor')
    .option('--config <path>', 'Path to .ragconfig.json')
    .action(async (opts) => {
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
        {
          kVector: config.retrieval.kVector,
          kFts: config.retrieval.kFts,
          symbolIndex,
          expandMaxTokens: contextTokens,
          expandDepth: config.retrieval.expandDepth,
        },
        config,
      )

      await startMCPServer(config, { retriever, symbolIndex, root: config.root })
    })
}
