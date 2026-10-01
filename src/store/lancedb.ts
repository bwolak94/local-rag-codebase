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
  private metaChecked = false

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

  async checkMeta(currentModel: string, currentDim: number): Promise<void> {
    if (this.metaChecked) return
    const meta = await this.getMeta()
    this.metaChecked = true
    if (!meta) return
    if (meta.embedModel !== currentModel) {
      throw new ModelMismatchError(meta.embedModel, currentModel)
    }
    if (currentDim > 0 && meta.dim !== currentDim) {
      throw new ModelMismatchError(`${meta.embedModel}(dim=${meta.dim})`, `${currentModel}(dim=${currentDim})`)
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

    // persist meta from first chunk's vector length — always update so --full reindex is reflected
    const firstChunk = chunks[0]
    if (firstChunk !== undefined) {
      const dim = firstChunk.vector.length
      await this.setMeta(this.embedModel, dim)
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
    await this.checkMeta(this.embedModel, vector.length)
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
      if (filter?.lang && filter.lang.length > 0) {
        const langs = filter.lang.map(l => `'${l.replace(/'/g, "''")}'`).join(', ')
        q = q.where(`lang IN (${langs})`)
      }
      if (filter?.kind && filter.kind.length > 0) {
        const kinds = filter.kind.map(k => `'${k.replace(/'/g, "''")}'`).join(', ')
        q = q.where(`kind IN (${kinds})`)
      }
      const rows = await q.toArray()
      return rows.map(r => ({
        chunk: rowToChunk(r),
        score: 1 / (1 + Number(r['_distance'] ?? 0)),
        source: 'vector' as const,
      }))
    } catch {
      return []
    }
  }

  async textSearch(query: string, k: number, filter?: SearchFilter): Promise<ScoredChunk[]> {
    await this.checkMeta(this.embedModel, 0)
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
      if (filter?.lang && filter.lang.length > 0) {
        const langs = filter.lang.map(l => `'${l.replace(/'/g, "''")}'`).join(', ')
        q = q.where(`lang IN (${langs})`)
      }
      if (filter?.kind && filter.kind.length > 0) {
        const kinds = filter.kind.map(k => `'${k.replace(/'/g, "''")}'`).join(', ')
        q = q.where(`kind IN (${kinds})`)
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

  async getByIds(ids: string[]): Promise<ScoredChunk[]> {
    if (ids.length === 0) return []
    try {
      const db = await this.connect()
      const names = await db.tableNames()
      if (!names.includes(CHUNKS_TABLE)) return []
      const tbl = await db.openTable(CHUNKS_TABLE)
      const escaped = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(', ')
      const rows = await tbl.query().where(`id IN (${escaped})`).toArray()
      return rows.map(r => ({
        chunk: rowToChunk(r),
        score: 1,
        source: 'expanded' as const,
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
