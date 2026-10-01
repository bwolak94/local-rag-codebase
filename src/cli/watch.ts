import { Command } from 'commander'
import chokidar from 'chokidar'
import { resolve, relative } from 'node:path'
import { loadConfig } from '../config/loader.js'
import { createEmbedder } from '../embedding/factory.js'
import { createStore } from '../store/factory.js'
import { IndexPipeline } from '../ingest/pipeline.js'

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

      // set up watcher
      const pending = new Set<string>()
      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      let isFlushing = false

      const flush = async () => {
        if (isFlushing) {
          // re-schedule: another flush is already running
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => { void flush() }, 500)
          return
        }
        isFlushing = true
        try {
          const paths = [...pending].map(abs => relative(config.root, abs))
          pending.clear()
          for (const p of paths) console.log(`[watch] ${p} changed`)
          const r = await pipeline.run({ paths })
          if (r.scanned === 0 && paths.length > 0) {
            console.log('[watch] note: some paths not yet tracked by git (run git add)')
          }
          console.log(`[watch] ${r.chunks} chunks reindexed in ${(r.elapsed / 1000).toFixed(1)}s`)
        } finally {
          isFlushing = false
        }
      }

      const schedule = (path: string) => {
        pending.add(path)
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => { void flush() }, 500)
      }

      chokidar
        .watch(resolve(config.root), {
          ignored: /(node_modules|\.git|\.rag|dist)/,
          ignoreInitial: true,
          persistent: true,
        })
        .on('add', schedule)
        .on('change', schedule)
        .on('unlink', schedule)

      console.log('[watch] Watching for changes. Ctrl+C to stop.')
    })
}
