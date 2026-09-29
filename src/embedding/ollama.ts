import { Ollama } from 'ollama'
import type { Embedder } from '../types/index.js'

const TASK_PREFIXES: Record<string, string> = {
  'nomic-embed-text': 'search_document: ',
  'bge-m3': '',
}

const QUERY_PREFIXES: Record<string, string> = {
  'nomic-embed-text': 'search_query: ',
  'bge-m3': '',
}

export class OllamaEmbedder implements Embedder {
  readonly model: string
  dim: number = 0

  private client: Ollama
  private batchSize: number

  constructor(model: string, batchSize = 48, host = 'http://localhost:11434') {
    this.model = model
    this.batchSize = batchSize
    this.client = new Ollama({ host })
  }

  async embed(texts: string[], mode: 'document' | 'query'): Promise<number[][]> {
    const prefix = mode === 'query'
      ? (QUERY_PREFIXES[this.model] ?? '')
      : (TASK_PREFIXES[this.model] ?? '')

    const prefixed = texts.map(t => prefix + t)
    const results: number[][] = []

    for (let i = 0; i < prefixed.length; i += this.batchSize) {
      const batch = prefixed.slice(i, i + this.batchSize)
      const res = await this.client.embed({ model: this.model, input: batch })
      results.push(...res.embeddings)
    }

    if (results[0] !== undefined && this.dim === 0) {
      this.dim = results[0].length
    }

    return results
  }
}
