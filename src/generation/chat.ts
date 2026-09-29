import { Ollama } from 'ollama'
import { assembleMessages } from './prompt.js'
import { allocateBudget, trimContext, trimHistory } from './budget.js'
import type { Generator, ScoredChunk, ChatTurn } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'

export class OllamaGenerator implements Generator {
  private client: Ollama

  constructor(
    private config: RagConfig,
    host = 'http://localhost:11434',
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

    for await (const chunk of stream) {
      const text = chunk.message.content
      if (text) yield text
    }
  }
}
