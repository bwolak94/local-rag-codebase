import { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { OllamaEmbedder } from '../embedding/ollama.js'
import { LanceDBStore, ModelMismatchError } from '../store/lancedb.js'
import { IndexPipeline } from '../ingest/pipeline.js'

export function register(program: Command) {
  program
    .command('index')
    .description('Incrementally (re)index the repository')
    .option('--full', 'Drop and rebuild the entire index')
    .option('--config <path>', 'Path to .ragconfig.json')
    .action(async (opts) => {
      const config = loadConfig({}, opts.config)
      const store = new LanceDBStore(config.store.path, config.root, config.embedding.model)
      const embedder = new OllamaEmbedder(config.embedding.model, config.embedding.batchSize)

      // model mismatch guard
      const meta = await store.getMeta()
      if (meta && meta.embedModel !== config.embedding.model) {
        throw new ModelMismatchError(meta.embedModel, config.embedding.model)
      }

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
