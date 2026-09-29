import { Command } from 'commander'
import { loadConfig } from '../config/loader.js'
import { collectFiles } from '../ingest/walker.js'
import { TreeSitterChunker } from '../chunking/treesitter.js'
import { SlidingWindowChunker } from '../chunking/fallback.js'
import { OllamaEmbedder } from '../embedding/ollama.js'
import { LanceDBStore, ModelMismatchError } from '../store/lancedb.js'
import type { EmbeddedChunk } from '../types/index.js'

export function register(program: Command) {
  program
    .command('index')
    .description('Incrementally (re)index the repository')
    .option('--full', 'Drop and rebuild the entire index')
    .option('--config <path>', 'Path to .ragconfig.json')
    .action(async (opts) => {
      const config = loadConfig({}, opts.config)
      const store = new LanceDBStore(config.store.path, config.root)
      const embedder = new OllamaEmbedder(config.embedding.model, config.embedding.batchSize)

      // model mismatch guard
      const meta = await store.getMeta()
      if (meta && meta.embedModel !== 'unknown' && meta.embedModel !== config.embedding.model) {
        throw new ModelMismatchError(meta.embedModel, config.embedding.model)
      }

      console.log('[index] Collecting files...')
      const files = await collectFiles(config.root, config.include, config.exclude, config.maxFileBytes)
      console.log(`[index] ${files.length} files found`)

      const tsChunker = new TreeSitterChunker()
      const fallbackChunker = new SlidingWindowChunker()

      let totalChunks = 0
      const start = Date.now()

      for (const file of files) {
        const chunker = tsChunker.supports(file) ? tsChunker : fallbackChunker
        const chunks = await chunker.chunk(file)

        if (chunks.length === 0) continue

        // embed in batches
        const texts = chunks.map(c => c.header + '\n' + c.content)
        const vectors = await embedder.embed(texts, 'document')

        const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({
          ...c,
          vector: vectors[i]!,
        }))

        await store.upsert(embedded)
        totalChunks += embedded.length
      }

      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`[index] ${totalChunks} chunks embedded in ${elapsed}s`)
    })
}
