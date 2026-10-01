import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { EmbeddedChunk, ScoredChunk, SearchFilter, Store } from '../types/index.js'
import { ModelMismatchError } from './errors.js'

export class SQLiteStore implements Store {
  private db: Database.Database
  private embedModel: string

  constructor(storePath: string, root: string, embedModel: string) {
    this.embedModel = embedModel
    const dbDir = resolve(root, storePath)
    mkdirSync(dbDir, { recursive: true })
    this.db = new Database(resolve(dbDir, 'index.db'))
    this.db.pragma('journal_mode = WAL')
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        lang TEXT NOT NULL,
        kind TEXT NOT NULL,
        symbol TEXT,
        startLine INTEGER NOT NULL,
        endLine INTEGER NOT NULL,
        header TEXT NOT NULL,
        content TEXT NOT NULL,
        hash TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        content=chunks,
        content_rowid=rowid
      );

      CREATE TABLE IF NOT EXISTS chunks_vec (
        chunk_id TEXT PRIMARY KEY,
        embedding TEXT NOT NULL
      );
    `)
  }

  async getMeta(): Promise<{ embedModel: string; dim: number } | null> {
    const embedModelRow = this.db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get('embedModel')
    const dimRow = this.db
      .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
      .get('dim')
    if (!embedModelRow || !dimRow) return null
    return { embedModel: embedModelRow.value, dim: Number(dimRow.value) }
  }

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return

    const meta = await this.getMeta()
    if (meta && meta.embedModel !== this.embedModel) {
      throw new ModelMismatchError(meta.embedModel, this.embedModel)
    }

    const insertChunk = this.db.prepare(`
      INSERT OR REPLACE INTO chunks
        (id, path, lang, kind, symbol, startLine, endLine, header, content, hash)
      VALUES
        (@id, @path, @lang, @kind, @symbol, @startLine, @endLine, @header, @content, @hash)
    `)

    const deleteFts = this.db.prepare(`
      DELETE FROM chunks_fts WHERE rowid = (SELECT rowid FROM chunks WHERE id = ?)
    `)

    const insertFts = this.db.prepare(`
      INSERT INTO chunks_fts(rowid, content)
      SELECT rowid, content FROM chunks WHERE id = ?
    `)

    const upsertVec = this.db.prepare(`
      INSERT OR REPLACE INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)
    `)

    const setMeta = this.db.prepare(
      'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'
    )

    const run = this.db.transaction((chunks: EmbeddedChunk[]) => {
      if (!meta) {
        const dim = chunks[0]!.vector.length
        setMeta.run('embedModel', this.embedModel)
        setMeta.run('dim', String(dim))
      }
      for (const c of chunks) {
        deleteFts.run(c.id)
        insertChunk.run({
          id: c.id,
          path: c.path,
          lang: c.lang,
          kind: c.kind,
          symbol: c.symbol ?? null,
          startLine: c.startLine,
          endLine: c.endLine,
          header: c.header,
          content: c.content,
          hash: c.hash,
        })
        insertFts.run(c.id)
        upsertVec.run(c.id, JSON.stringify(c.vector))
      }
    })

    run(chunks)
  }

  async deleteByPath(path: string): Promise<void> {
    const getRowids = this.db
      .prepare<[string], { rowid: number; id: string }>(
        'SELECT rowid, id FROM chunks WHERE path = ?'
      )
      .all(path)

    const deleteFtsRow = this.db.prepare(
      'DELETE FROM chunks_fts WHERE rowid = ?'
    )
    const deleteVec = this.db.prepare(
      'DELETE FROM chunks_vec WHERE chunk_id = ?'
    )
    const deleteChunk = this.db.prepare('DELETE FROM chunks WHERE path = ?')

    const run = this.db.transaction(() => {
      for (const row of getRowids) {
        deleteFtsRow.run(row.rowid)
        deleteVec.run(row.id)
      }
      deleteChunk.run(path)
    })

    run()
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const getRowids = this.db
      .prepare<string[], { rowid: number; id: string }>(
        `SELECT rowid, id FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids)

    const deleteFtsRow = this.db.prepare('DELETE FROM chunks_fts WHERE rowid = ?')
    const deleteVec = this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?')
    const placeholders = ids.map(() => '?').join(',')
    const deleteChunk = this.db.prepare(`DELETE FROM chunks WHERE id IN (${placeholders})`)

    const run = this.db.transaction(() => {
      for (const row of getRowids) {
        deleteFtsRow.run(row.rowid)
        deleteVec.run(row.id)
      }
      deleteChunk.run(...ids)
    })

    run()
  }

  async vectorSearch(
    vector: number[],
    k: number,
    filter?: SearchFilter
  ): Promise<ScoredChunk[]> {
    const meta = await this.getMeta()
    if (meta && meta.dim !== vector.length) {
      throw new ModelMismatchError(
        `${meta.embedModel}(dim=${meta.dim})`,
        `${this.embedModel}(dim=${vector.length})`,
      )
    }

    type VecRow = { chunk_id: string; embedding: string }
    const allVecs = this.db
      .prepare<[], VecRow>('SELECT chunk_id, embedding FROM chunks_vec')
      .all()

    if (allVecs.length === 0) return []

    const scored = allVecs.map(row => {
      const emb: number[] = JSON.parse(row.embedding)
      const dist = l2Distance(vector, emb)
      return { chunk_id: row.chunk_id, dist }
    })

    scored.sort((a, b) => a.dist - b.dist)

    const results: ScoredChunk[] = []
    for (const { chunk_id, dist } of scored) {
      if (results.length >= k) break
      const chunk = this.db
        .prepare<[string], ChunkRow>('SELECT * FROM chunks WHERE id = ?')
        .get(chunk_id)
      if (!chunk) continue
      if (!matchesFilter(chunk, filter)) continue
      results.push({
        chunk: rowToChunk(chunk),
        score: 1 / (1 + dist),
        source: 'vector',
      })
    }

    return results
  }

  async textSearch(
    query: string,
    k: number,
    filter?: SearchFilter
  ): Promise<ScoredChunk[]> {
    type FtsRow = { rowid: number; rank: number }
    let ftsRows: FtsRow[]
    try {
      ftsRows = this.db
        .prepare<[string], FtsRow>(
          'SELECT rowid, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank'
        )
        .all(query)
    } catch {
      return []
    }

    if (ftsRows.length === 0) return []

    const results: ScoredChunk[] = []
    for (const { rowid, rank } of ftsRows) {
      if (results.length >= k) break
      const chunk = this.db
        .prepare<[number], ChunkRow>('SELECT * FROM chunks WHERE rowid = ?')
        .get(rowid)
      if (!chunk) continue
      if (!matchesFilter(chunk, filter)) continue
      results.push({
        chunk: rowToChunk(chunk),
        score: -rank,
        source: 'fts',
      })
    }

    return results
  }

  async getByIds(ids: string[]): Promise<ScoredChunk[]> {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db
      .prepare<string[], ChunkRow>(
        `SELECT * FROM chunks WHERE id IN (${placeholders})`
      )
      .all(...ids)
    return rows.map(r => ({
      chunk: rowToChunk(r),
      score: 1,
      source: 'expanded' as const,
    }))
  }
}

interface ChunkRow {
  id: string
  path: string
  lang: string
  kind: string
  symbol: string | null
  startLine: number
  endLine: number
  header: string
  content: string
  hash: string
}

function rowToChunk(r: ChunkRow): import('../types/index.js').Chunk {
  return {
    id: r.id,
    path: r.path,
    lang: r.lang,
    kind: r.kind as import('../types/index.js').ChunkKind,
    symbol: r.symbol ?? undefined,
    startLine: r.startLine,
    endLine: r.endLine,
    header: r.header,
    content: r.content,
    hash: r.hash,
  }
}

function matchesFilter(row: ChunkRow, filter?: SearchFilter): boolean {
  if (!filter) return true
  if (filter.pathPrefix && !row.path.startsWith(filter.pathPrefix)) return false
  if (filter.lang && filter.lang.length > 0 && !filter.lang.includes(row.lang))
    return false
  if (
    filter.kind &&
    filter.kind.length > 0 &&
    !filter.kind.includes(row.kind as import('../types/index.js').ChunkKind)
  )
    return false
  return true
}

function l2Distance(a: number[], b: number[]): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    sum += diff * diff
  }
  return Math.sqrt(sum)
}
