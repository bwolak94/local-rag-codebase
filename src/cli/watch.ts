import { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { createEmbedder } from '../embedding/factory.js'
import { createStore } from '../store/factory.js'
import { IndexPipeline } from '../ingest/pipeline.js'
import { createWatcher } from '../ingest/watcher.js'

export function register(program: Command) {
  program
    .command('watch')
    .description('Continuously index the repository on file changes')
    .option('--config <path>', 'Path to .ragconfig.json')
    .action(async (opts) => {
      const config = loadConfig({}, opts.config)
      const store = createStore(config)
      const embedder = createEmbedder(config)
      const pipeline = new IndexPipeline(config, store, embedder)

      // initial full incremental index
      console.log('[watch] Initial indexing...')
      const result = await pipeline.run()
      console.log(`[watch] ${result.scanned} files scanned, ${result.chunks} chunks indexed`)

      createWatcher({
        root: config.root,
        include: config.include,
        exclude: config.exclude,
        onChanges: async (paths) => {
          for (const p of paths) console.log(`[watch] ${p} changed`)
          const r = await pipeline.run({ paths })
          if (r.scanned === 0 && paths.length > 0) {
            console.log('[watch] note: some paths not yet tracked by git (run git add)')
          }
          console.log(`[watch] ${r.chunks} chunks reindexed in ${(r.elapsed / 1000).toFixed(1)}s`)
        },
      })

      console.log('[watch] Watching for changes. Ctrl+C to stop.')
    })
}
