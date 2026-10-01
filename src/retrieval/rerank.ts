import { Ollama } from 'ollama'
import type { ScoredChunk } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'

// LLM-based reranker: asks the model to score each chunk for relevance to the query
// Slow — one LLM call per chunk — opt-in only via config.retrieval.rerank: 'llm'
export async function rerankWithLLM(
  query: string,
  chunks: ScoredChunk[],
  config: RagConfig,
  host = 'http://localhost:11434',
): Promise<ScoredChunk[]> {
  if (chunks.length === 0) return chunks
  const client = new Ollama({ host })

  const scored: ScoredChunk[] = []
  for (const { chunk, source } of chunks) {
    const prompt = `Rate how relevant this code snippet is to the question on a scale of 0.0 to 1.0.
Return ONLY a number between 0.0 and 1.0 with no explanation.

Question: ${query}

Code snippet (${chunk.path}:${chunk.startLine}-${chunk.endLine}):
${chunk.content.slice(0, 800)}

Relevance score:`

    try {
      const res = await client.generate({
        model: config.llm.model,
        prompt,
        stream: false,
        options: { num_ctx: config.llm.numCtx, temperature: 0 }, // num_ctx MUST be set
      })
      const score = parseFloat(res.response.trim())
      scored.push({ chunk, score: isNaN(score) ? 0 : Math.min(1, Math.max(0, score)), source })
    } catch {
      scored.push({ chunk, score: 0, source })
    }
  }

  return scored.sort((a, b) => b.score - a.score)
}

// Stub for ONNX cross-encoder reranker (Stage 5 optional)
// Full implementation requires @xenova/transformers which is an optional dependency
export async function crossEncoderRerank(
  _query: string,
  chunks: ScoredChunk[],
): Promise<ScoredChunk[]> {
  // Not yet implemented — requires @xenova/transformers (optional dep)
  return chunks
}

export async function rerank(
  query: string,
  chunks: ScoredChunk[],
  config: RagConfig,
  host = 'http://localhost:11434',
): Promise<ScoredChunk[]> {
  if (config.retrieval.rerank === 'llm') return rerankWithLLM(query, chunks, config, host)
  if (config.retrieval.rerank === 'cross-encoder') {
    console.error('[rerank] cross-encoder is not yet implemented. Returning chunks unranked. Set rerank: "none" to suppress this message.')
    return crossEncoderRerank(query, chunks)
  }
  return chunks
}
