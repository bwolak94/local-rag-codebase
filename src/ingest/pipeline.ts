import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectFiles } from './walker.js'
import { TreeSitterChunker } from '../chunking/treesitter.js'
import { SlidingWindowChunker } from '../chunking/fallback.js'
import type { Embedder, Store, EmbeddedChunk } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'

interface FileRecord {
  path: string
  hash: string
  indexedAt: number
}

export class IndexPipeline {
  private db: Database.Database

  constructor(
    private config: RagConfig,
    private store: Store,
    private embedder: Embedder,
  ) {
    const storeDir = resolve(config.root, config.store.path)
    mkdirSync(storeDir, { recursive: true })
    const dbPath = resolve(storeDir, 'files.db')
    this.db = new Database(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        indexedAt INTEGER NOT NULL
      )
    `)
  }

  private getRecord(path: string): FileRecord | undefined {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRecord | undefined
  }

  private upsertRecord(path: string, hash: string): void {
    this.db
      .prepare(
        'INSERT INTO files (path, hash, indexedAt) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, indexedAt=excluded.indexedAt',
      )
      .run(path, hash, Date.now())
  }

  private deleteRecord(path: string): void {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path)
  }

  private getAllPaths(): string[] {
    const rows = this.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>
    return rows.map(r => r.path)
  }

  async run(opts: { full?: boolean; paths?: string[] } = {}): Promise<{
    scanned: number
    changed: number
    added: number
    deleted: number
    chunks: number
    elapsed: number
  }> {
    const start = Date.now()

    if (opts.full) {
      // Delete all vectors from the store before clearing the tracking table so
      // stale chunks do not remain in LanceDB after a full rebuild.
      const oldPaths = this.getAllPaths()
      for (const p of oldPaths) {
        await this.store.deleteByPath(p)
      }
      this.db.exec('DELETE FROM files')
    }

    const allFiles = await collectFiles(
      this.config.root,
      this.config.include,
      this.config.exclude,
      this.config.maxFileBytes,
    )

    // filter to specific paths if provided (watch mode)
    // Note: collectFiles relies on git-tracked files, so newly created files that
    // have not yet been staged with `git add` will not appear in allFiles and
    // will produce no work even when listed in opts.paths.
    const targetFiles = opts.paths
      ? allFiles.filter(f => opts.paths!.includes(f.path))
      : allFiles

    const currentPaths = new Set(allFiles.map(f => f.path))
    const tsChunker = new TreeSitterChunker()
    const fallback = new SlidingWindowChunker()

    let changed = 0
    let added = 0
    let totalChunks = 0

    for (const file of targetFiles) {
      const existing = this.getRecord(file.path)
      if (existing && existing.hash === file.hash && !opts.full) continue

      if (existing) {
        changed++
      } else {
        added++
      }

      await this.store.deleteByPath(file.path)

      const chunker = tsChunker.supports(file) ? tsChunker : fallback
      const chunks = await chunker.chunk(file)
      if (chunks.length === 0) {
        this.upsertRecord(file.path, file.hash)
        continue
      }

      const texts = chunks.map(c => c.header + '\n' + c.content)
      const vectors = await this.embedder.embed(texts, 'document')

      if (vectors.length !== chunks.length) {
        throw new Error(`Embedder returned ${vectors.length} vectors for ${chunks.length} chunks in ${file.path}`)
      }
      const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({ ...c, vector: vectors[i]! }))
      await this.store.upsert(embedded)
      this.upsertRecord(file.path, file.hash)
      totalChunks += embedded.length
    }

    // handle deletions
    const indexedPaths = this.getAllPaths()
    let deleted = 0
    for (const p of indexedPaths) {
      if (!currentPaths.has(p)) {
        await this.store.deleteByPath(p)
        this.deleteRecord(p)
        deleted++
      }
    }

    return {
      scanned: allFiles.length,
      changed,
      added,
      deleted,
      chunks: totalChunks,
      elapsed: Date.now() - start,
    }
  }
}
