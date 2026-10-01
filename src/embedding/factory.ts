import type { RagConfig } from '../config/schema.js'
import { OllamaEmbedder } from './ollama.js'

export function createEmbedder(config: RagConfig): OllamaEmbedder {
  return new OllamaEmbedder(config.embedding.model, config.embedding.batchSize, config.embedding.host)
}
