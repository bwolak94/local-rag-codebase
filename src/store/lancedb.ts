import * as lancedb from '@lancedb/lancedb'
import { resolve } from 'node:path'
import type { EmbeddedChunk, ScoredChunk, SearchFilter, Store } from '../types/index.js'

export class ModelMismatchError extends Error {
  constructor(stored: string, current: string) {
    super(`Embedding model mismatch: index was built with "${stored}", current model is "${current}". Run \`rag index --full\` to rebuild.`)
    this.name = 'ModelMismatchError'
  }
}

const META_TABLE = 'index_meta'
const CHUNKS_TABLE = 'chunks'

export class LanceDBStore implements Store {
  private dbPath: string
  private db: lancedb.Connection | null = null

  constructor(storePath: string, root: string, private embedModel: string) {
    this.dbPath = resolve(root, storePath)
  }

  private async connect(): Promise<lancedb.Connection> {
    if (!this.db) {
      this.db = await lancedb.connect(this.dbPath)
    }
    return this.db
  }

  async getMeta(): Promise<{ embedModel: string; dim: number } | null> {
    try {
      const db = await this.connect()
      const names = await db.tableNames()
      if (!names.includes(META_TABLE)) return null
      const tbl = await db.openTable(META_TABLE)
      const rows = await tbl.query().limit(1).toArray()
      if (!rows[0]) return null
      return { embedModel: String(rows[0]['embedModel']), dim: Number(rows[0]['dim']) }
    } catch {
      return null
    }
  }

  private async setMeta(embedModel: string, dim: number): Promise<void> {
    const db = await this.connect()
    const names = await db.tableNames()
    if (names.includes(META_TABLE)) {
      await db.dropTable(META_TABLE)
    }
    await db.createTable(META_TABLE, [{ embedModel, dim }])
  }

  async upsert(chunks: EmbeddedChunk[]): Promise<void> {
    if (chunks.length === 0) return
    const db = await this.connect()
    const names = await db.tableNames()

    const rows = chunks.map(c => ({
      id: c.id,
      path: c.path,
      lang: c.lang,
      kind: c.kind,
      symbol: c.symbol ?? '',
      startLine: c.startLine,
      endLine: c.endLine,
      header: c.header,
      content: c.content,
      hash: c.hash,
      vector: c.vector,
    }))

    if (!names.includes(CHUNKS_TABLE)) {
      await db.createTable(CHUNKS_TABLE, rows)
    } else {
      const tbl = await db.openTable(CHUNKS_TABLE)
      // upsert by merging on id
      await tbl.mergeInsert('id')
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(rows)
    }

    // persist meta from first chunk's vector length
    const firstChunk = chunks[0]
    if (firstChunk !== undefined) {
      const dim = firstChunk.vector.length
      const meta = await this.getMeta()
      if (!meta) {
        await this.setMeta(this.embedModel, dim)
      }
    }
  }

  async deleteByPath(path: string): Promise<void> {
    try {
      const db = await this.connect()
      const names = await db.tableNames()
      if (!names.includes(CHUNKS_TABLE)) return
      const tbl = await db.openTable(CHUNKS_TABLE)
      await tbl.delete(`path = '${path.replace(/'/g, "''")}'`)
    } catch {
      // table may not exist yet
    }
  }

  async vectorSearch(vector: number[], k: number, filter?: SearchFilter): Promise<ScoredChunk[]> {
    try {
      const db = await this.connect()
      const names = await db.tableNames()
      if (!names.includes(CHUNKS_TABLE)) return []
      const tbl = await db.openTable(CHUNKS_TABLE)
      let q = tbl.vectorSearch(vector).limit(k)
      if (filter?.pathPrefix) {
        const safePrefix = filter.pathPrefix.replace(/'/g, "''")
        q = q.where(`path LIKE '${safePrefix}%'`)
      }
      const rows = await q.toArray()
      return rows.map(r => ({
        chunk: rowToChunk(r),
        score: Number(r['_distance'] ?? 0),
        source: 'vector' as const,
      }))
    } catch {
      return []
    }
  }

  async textSearch(query: string, k: number, filter?: SearchFilter): Promise<ScoredChunk[]> {
    try {
      const db = await this.connect()
      const names = await db.tableNames()
      if (!names.includes(CHUNKS_TABLE)) return []
      const tbl = await db.openTable(CHUNKS_TABLE)
      let q = tbl.search(query).limit(k)
      if (filter?.pathPrefix) {
        const safePrefix = filter.pathPrefix.replace(/'/g, "''")
        q = q.where(`path LIKE '${safePrefix}%'`)
      }
      const rows = await q.toArray()
      return rows.map(r => ({
        chunk: rowToChunk(r),
        score: Number(r['_score'] ?? 0),
        source: 'fts' as const,
      }))
    } catch {
      return []
    }
  }
}

function rowToChunk(r: Record<string, unknown>): import('../types/index.js').Chunk {
  return {
    id: String(r['id']),
    path: String(r['path']),
    lang: String(r['lang']),
    kind: String(r['kind']) as import('../types/index.js').ChunkKind,
    symbol: r['symbol'] ? String(r['symbol']) : undefined,
    startLine: Number(r['startLine']),
    endLine: Number(r['endLine']),
    header: String(r['header']),
    content: String(r['content']),
    hash: String(r['hash']),
  }
}
