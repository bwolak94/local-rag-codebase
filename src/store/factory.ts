import type { Store } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'
import { LanceDBStore } from './lancedb.js'
import { SQLiteStore } from './sqlite.js'

export function createStore(config: RagConfig): Store {
  if (config.store.driver === 'sqlite') {
    return new SQLiteStore(config.store.path, config.root, config.embedding.model)
  }
  return new LanceDBStore(config.store.path, config.root, config.embedding.model)
}
