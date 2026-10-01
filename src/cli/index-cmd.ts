import { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { createStore } from '../store/factory.js'
import { IndexPipeline } from '../ingest/pipeline.js'
import { createEmbedder } from '../embedding/factory.js'

export function register(program: Command) {
  program
    .command('index')
    .description('Incrementally (re)index the repository')
    .option('--full', 'Drop and rebuild the entire index')
    .option('--config <path>', 'Path to .ragconfig.json')
    .action(async (opts) => {
      const config = loadConfig({}, opts.config)
      const store = createStore(config)
      const embedder = createEmbedder(config)

      const pipeline = new IndexPipeline(config, store, embedder)
      const result = await pipeline.run({ full: opts.full === true })

      console.log(
        `[index] ${result.scanned} files scanned, ${result.changed} changed, ${result.added} added, ${result.deleted} deleted`,
      )
      console.log(
        `[index] ${result.chunks} chunks embedded in ${(result.elapsed / 1000).toFixed(1)}s`,
      )
    })
}
