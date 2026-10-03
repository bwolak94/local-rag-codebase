import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectFiles } from './walker.js'
import { TreeSitterChunker } from '../chunking/treesitter.js'
import { getParser } from '../chunking/treesitter.js'
import { SlidingWindowChunker } from '../chunking/fallback.js'
import { SQLiteSymbolIndex } from '../symbols/index.js'
import { extractSymbols } from '../symbols/extractor.js'
import { ModelMismatchError } from '../store/errors.js'
import type { Embedder, Store, EmbeddedChunk, SourceFile, SymbolIndex } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'

interface FileRecord {
  path: string
  hash: string
  indexedAt: number
  embed_model: string
}

export class IndexPipeline {
  private db: Database.Database
  readonly symbolIndex: SymbolIndex

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
        indexedAt INTEGER NOT NULL,
        embed_model TEXT NOT NULL DEFAULT ''
      )
    `)
    // Migration: add embed_model column to existing databases that predate this schema change
    try {
      this.db.exec(`ALTER TABLE files ADD COLUMN embed_model TEXT NOT NULL DEFAULT ''`)
    } catch {
      // Column already exists — safe to ignore
    }
    this.initChunkHashes()
    this.symbolIndex = new SQLiteSymbolIndex(config.store.path, config.root)
  }

  private initChunkHashes(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_hashes (
        chunkId TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_hashes_path ON chunk_hashes(path);
    `)
  }

  private getChunkHashesForPath(path: string): Map<string, string> {
    const rows = this.db.prepare('SELECT chunkId, hash FROM chunk_hashes WHERE path = ?')
      .all(path) as Array<{ chunkId: string; hash: string }>
    return new Map(rows.map(r => [r.chunkId, r.hash]))
  }

  private upsertChunkHash(chunkId: string, path: string, hash: string): void {
    this.db.prepare(
      'INSERT INTO chunk_hashes (chunkId, path, hash) VALUES (?, ?, ?) ON CONFLICT(chunkId) DO UPDATE SET hash=excluded.hash, path=excluded.path'
    ).run(chunkId, path, hash)
  }

  private deleteChunkHashesForPath(path: string): void {
    this.db.prepare('DELETE FROM chunk_hashes WHERE path = ?').run(path)
  }

  private getRecord(path: string): FileRecord | undefined {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRecord | undefined
  }

  private upsertRecord(path: string, hash: string): void {
    this.db
      .prepare(
        'INSERT INTO files (path, hash, indexedAt, embed_model) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, indexedAt=excluded.indexedAt, embed_model=excluded.embed_model',
      )
      .run(path, hash, Date.now(), this.config.embedding.model)
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

    // Guard against embedding model mismatch before doing any work
    const meta = await this.store.getMeta()
    if (meta && meta.embedModel !== this.config.embedding.model) {
      throw new ModelMismatchError(meta.embedModel, this.config.embedding.model)
    }

    if (opts.full) {
      // Delete all vectors from the store before clearing the tracking table so
      // stale chunks do not remain in LanceDB after a full rebuild.
      const oldPaths = this.getAllPaths()
      // Track all paths that need deletion; only clear the files table after
      // all vector store deletes succeed (compensation pattern).
      const pendingDeletes = new Set<string>(oldPaths)
      try {
        for (const p of pendingDeletes) {
          await this.store.deleteByPath(p)
          await this.symbolIndex.deleteByPath(p)
          this.deleteChunkHashesForPath(p)
        }
        this.db.exec('DELETE FROM files')
        this.db.exec('VACUUM')
      } catch (err) {
        console.warn('[IndexPipeline] Full reindex interrupted. Run with --full again to ensure consistency.')
        throw err
      }
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

    // First pass: chunk all changed files and collect texts for batch embedding.
    interface PendingFile {
      file: SourceFile
      chunks: Awaited<ReturnType<typeof tsChunker.chunk>>
      texts: string[]
      offset: number
    }
    const pending: PendingFile[] = []
    let allTexts: string[] = []

    for (const file of targetFiles) {
      const existing = this.getRecord(file.path)
      if (existing && existing.hash === file.hash && !opts.full) continue

      if (existing) {
        changed++
      } else {
        added++
      }

      const chunker = tsChunker.supports(file) ? tsChunker : fallback
      const chunks = await chunker.chunk(file)

      // Chunk-level hash diffing: compare each chunk's hash against stored hashes
      const oldChunkHashes = this.getChunkHashesForPath(file.path)
      const newChunkIds = new Set(chunks.map(c => c.id))

      // Find removed chunk IDs (in old set but not in new)
      const removedChunkIds = [...oldChunkHashes.keys()].filter(id => !newChunkIds.has(id))

      // Find changed chunks (new hash or not in old set)
      const changedChunks = chunks.filter(c => oldChunkHashes.get(c.id) !== c.hash)

      // If nothing changed and nothing was removed, skip this file entirely
      // (handles whitespace-only file changes that don't affect chunk hashes)
      if (changedChunks.length === 0 && removedChunkIds.length === 0) {
        this.upsertRecord(file.path, file.hash)
        continue
      }

      // The Store interface supports deleteByPath but not per-chunk delete.
      // When any chunk changes we delete all vectors for this file and re-embed everything.
      await this.store.deleteByPath(file.path)
      await this.symbolIndex.deleteByPath(file.path)
      this.deleteChunkHashesForPath(file.path)

      if (chunks.length === 0) {
        this.upsertRecord(file.path, file.hash)
        continue
      }

      const texts = chunks.map(c => c.header + '\n' + c.content)
      pending.push({ file, chunks, texts, offset: allTexts.length })
      allTexts = allTexts.concat(texts)
    }

    // Batch embed all texts in a single Ollama round-trip.
    let allVectors: number[][] = []
    if (allTexts.length > 0) {
      allVectors = await this.embedder.embed(allTexts, 'document')
      if (allVectors.length !== allTexts.length) {
        throw new Error(`Embedder returned ${allVectors.length} vectors for ${allTexts.length} total texts`)
      }
    }

    // Second pass: slice embeddings back per file, upsert, and extract symbols.
    for (const { file, chunks, texts, offset } of pending) {
      const vectors = allVectors.slice(offset, offset + texts.length)

      if (vectors.length !== chunks.length) {
        throw new Error(`Embedder returned ${vectors.length} vectors for ${chunks.length} chunks in ${file.path}`)
      }
      const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({ ...c, vector: vectors[i]! }))
      await this.store.upsert(embedded)

      // Persist chunk hashes in a single transaction (one fsync instead of N)
      const upsertAll = this.db.transaction((cs: typeof chunks) => {
        for (const c of cs) this.upsertChunkHash(c.id, file.path, c.hash)
      })
      upsertAll(chunks)

      // Extract symbols and update symbol index.
      // Pass the chunks array so the extractor can resolve chunk IDs by line
      // overlap instead of recomputing them (which diverges for split chunks).
      const parser = await getParser(file.lang)
      if (parser) {
        try {
          const tree = parser.parse(file.content)
          const { defs, refs } = await extractSymbols(file, tree, chunks)
          await this.symbolIndex.upsert(defs, refs)
        } catch {
          // symbol extraction is best-effort — don't fail the whole pipeline
        }
      } else if (file.lang === 'vue') {
        // getParser returns null for vue — extract the <script> block and parse as TS/JS
        try {
          const re = /(<script[^>]*>)([\s\S]*?)(<\/script>)/i
          const m = re.exec(file.content)
          if (m) {
            const openTag = m[1] ?? ''
            const scriptContent = m[2] ?? ''
            const scriptLang = /lang=["']ts["']/.test(openTag) ? 'typescript' : 'javascript'
            const scriptParser = await getParser(scriptLang)
            if (scriptParser) {
              const scriptStart = m.index + openTag.length
              const lineOffset = (file.content.slice(0, scriptStart).match(/\n/g) ?? []).length
              const tree = scriptParser.parse(scriptContent)
              const syntheticFile: SourceFile = { ...file, lang: scriptLang, content: scriptContent }
              const { defs, refs } = await extractSymbols(syntheticFile, tree, chunks)
              // adjust line numbers back to vue file coordinates
              const adjustedDefs = defs.map(d => ({
                ...d, path: file.path,
                startLine: d.startLine + lineOffset,
                endLine: d.endLine + lineOffset,
              }))
              const adjustedRefs = refs.map(r => ({ ...r, path: file.path, line: r.line + lineOffset }))
              await this.symbolIndex.upsert(adjustedDefs, adjustedRefs)
            }
          }
        } catch {
          // symbol extraction is best-effort — don't fail the whole pipeline
        }
      }

      this.upsertRecord(file.path, file.hash)
      totalChunks += embedded.length
    }

    // handle deletions
    const indexedPaths = this.getAllPaths()
    let deleted = 0
    for (const p of indexedPaths) {
      if (!currentPaths.has(p)) {
        await this.store.deleteByPath(p)
        await this.symbolIndex.deleteByPath(p)
        this.deleteChunkHashesForPath(p)
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
