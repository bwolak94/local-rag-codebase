import { Ollama } from 'ollama'
import { assembleMessages } from './prompt.js'
import { allocateBudget, trimContext, trimHistory } from './budget.js'
import type { Generator, ScoredChunk, ChatTurn } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'

export function validateCitations(answer: string, context: ScoredChunk[]): string[] {
  const warnings: string[] = []
  const citationPattern = /\[([^\]]+):(\d+)-(\d+)\]/g
  const contextPaths = new Set(context.map(c => c.chunk.path))

  let match: RegExpExecArray | null
  while ((match = citationPattern.exec(answer)) !== null) {
    const [, path, startStr, endStr] = match
    if (!path || !startStr || !endStr) continue
    if (!contextPaths.has(path)) {
      warnings.push(`Cited file not in context: ${path}`)
      continue
    }
    const start = parseInt(startStr, 10)
    const end = parseInt(endStr, 10)
    const chunk = context.find(c => c.chunk.path === path)
    if (chunk && (start < chunk.chunk.startLine || end > chunk.chunk.endLine)) {
      warnings.push(`Line range [${start}-${end}] outside chunk bounds [${chunk.chunk.startLine}-${chunk.chunk.endLine}] for ${path}`)
    }
  }
  return warnings
}

export class OllamaGenerator implements Generator {
  private client: Ollama

  constructor(
    private config: RagConfig,
    host = 'http://localhost:11434',
    private enableValidateCitations = true,
  ) {
    this.client = new Ollama({ host })
  }

  async *answer(
    question: string,
    context: ScoredChunk[],
    history: ChatTurn[] = [],
  ): AsyncIterable<string> {
    const { contextTokens, historyTokens } = allocateBudget(
      this.config.llm.numCtx,
      this.config.budget.contextFraction,
      this.config.budget.historyFraction,
    )

    const trimmedContext = trimContext(context, contextTokens)
    const trimmedHistory = trimHistory(history, historyTokens)
    const messages = assembleMessages(question, trimmedContext, trimmedHistory)

    const stream = await this.client.chat({
      model: this.config.llm.model,
      messages: messages as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
      stream: true,
      options: {
        num_ctx: this.config.llm.numCtx,  // NEVER omit this
        temperature: this.config.llm.temperature,
      },
    })

    let fullAnswer = ''
    for await (const chunk of stream) {
      const text = chunk.message.content
      if (text) {
        fullAnswer += text
        yield text
      }
    }

    // After stream ends, validate citations and emit warnings if any
    if (this.enableValidateCitations) {
      const warnings = validateCitations(fullAnswer, context)
      if (warnings.length > 0) {
        yield '\n\n⚠️  Citation warnings:\n' + warnings.map(w => `  - ${w}`).join('\n')
      }
    }
  }
}
