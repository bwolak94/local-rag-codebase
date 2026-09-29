import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { SymbolDef, SymbolRef, SymbolIndex } from '../types/index.js'

export class SQLiteSymbolIndex implements SymbolIndex {
  private db: Database.Database

  constructor(storePath: string, root: string) {
    const dir = resolve(root, storePath)
    mkdirSync(dir, { recursive: true })
    this.db = new Database(resolve(dir, 'symbols.db'))
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_defs (
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        startLine INTEGER NOT NULL,
        endLine INTEGER NOT NULL,
        chunkId TEXT NOT NULL,
        PRIMARY KEY (path, startLine)
      );
      CREATE INDEX IF NOT EXISTS idx_defs_name ON symbol_defs(name);

      CREATE TABLE IF NOT EXISTS symbol_refs (
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        chunkId TEXT NOT NULL,
        -- UNIQUE constraint prevents duplicate rows on retry/re-index.
        -- Note: existing databases created before this migration will not have
        -- this constraint; a full re-index (--full) is required for them.
        UNIQUE(name, path, line)
      );
      CREATE INDEX IF NOT EXISTS idx_refs_name ON symbol_refs(name);
    `)
  }

  async upsert(defs: SymbolDef[], refs: SymbolRef[]): Promise<void> {
    const insertDef = this.db.prepare(`
      INSERT OR REPLACE INTO symbol_defs (name, kind, path, startLine, endLine, chunkId)
      VALUES (@name, @kind, @path, @startLine, @endLine, @chunkId)
    `)
    const insertRef = this.db.prepare(`
      INSERT OR IGNORE INTO symbol_refs (name, path, line, chunkId) VALUES (@name, @path, @line, @chunkId)
    `)

    const run = this.db.transaction(() => {
      for (const d of defs) insertDef.run(d)
      for (const r of refs) insertRef.run(r)
    })
    run()
  }

  async deleteByPath(path: string): Promise<void> {
    this.db.prepare('DELETE FROM symbol_defs WHERE path = ?').run(path)
    this.db.prepare('DELETE FROM symbol_refs WHERE path = ?').run(path)
  }

  async definitions(name: string): Promise<SymbolDef[]> {
    return this.db
      .prepare('SELECT * FROM symbol_defs WHERE name = ?')
      .all(name) as SymbolDef[]
  }

  async references(name: string): Promise<SymbolRef[]> {
    return this.db
      .prepare('SELECT * FROM symbol_refs WHERE name = ?')
      .all(name) as SymbolRef[]
  }

  async neighbors(chunkId: string, depth = 1): Promise<string[]> {
    // BFS: find all symbols defined in the same chunk,
    // then find all chunks that reference those symbols
    const visited = new Set<string>([chunkId])
    const queue: string[] = [chunkId]

    for (let d = 0; d < depth; d++) {
      const next: string[] = []

      for (const cid of queue) {
        // symbols defined in this chunk
        const defs = this.db
          .prepare('SELECT name FROM symbol_defs WHERE chunkId = ?')
          .all(cid) as Array<{ name: string }>

        for (const { name } of defs) {
          // chunks that reference this symbol
          const refChunks = this.db
            .prepare('SELECT DISTINCT chunkId FROM symbol_refs WHERE name = ?')
            .all(name) as Array<{ chunkId: string }>

          for (const { chunkId: nid } of refChunks) {
            if (!visited.has(nid)) {
              visited.add(nid)
              next.push(nid)
            }
          }
        }
      }

      queue.length = 0
      queue.push(...next)
    }

    visited.delete(chunkId) // don't include the seed itself
    return [...visited]
  }
}
