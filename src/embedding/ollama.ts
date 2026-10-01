import { Ollama } from 'ollama'
import type { Embedder } from '../types/index.js'

function l2Normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return norm === 0 ? v : v.map(x => x / norm)
}

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
  private _dim = 0
  get dim(): number { return this._dim }

  private client: Ollama
  private batchSize: number

  constructor(model: string, batchSize = 48, host = 'http://localhost:11434') {
    this.model = model
    this.batchSize = batchSize
    this.client = new Ollama({ host })
  }

  async warmUp(): Promise<void> {
    if (this._dim > 0) return
    await this.embed([''], 'document')
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
      results.push(...res.embeddings.map(l2Normalize))
    }

    if (results[0] !== undefined && this._dim === 0) {
      this._dim = results[0].length
    }

    return results
  }
}
