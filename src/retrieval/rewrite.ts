import { Ollama } from 'ollama'
import type { ChatTurn } from '../types/index.js'

// expandQuery: generates a hypothetical code snippet for the query (HyDE-lite)
// Returns the hypothetical snippet to use as a second retrieval query
export async function expandQuery(
  query: string,
  model: string,
  numCtx: number,
  temperature = 0.3,
  host = 'http://localhost:11434',
): Promise<string> {
  const client = new Ollama({ host })

  const prompt = `Write a short hypothetical code snippet (5-15 lines) that would be the answer to the following question about a TypeScript codebase. Write ONLY the code, no explanation.

Question: ${query}

Hypothetical code snippet:`

  try {
    const res = await client.generate({
      model,
      prompt,
      stream: false,
      options: { num_ctx: numCtx, temperature }, // num_ctx MUST be set
    })
    return res.response.trim() || query
  } catch {
    return query  // graceful fallback: use original query
  }
}

// condensQuestion: given a multi-turn history + new follow-up question,
// rewrite it as a standalone question that can be used for retrieval
// without needing the conversation context.
export async function condensQuestion(
  history: ChatTurn[],
  followUp: string,
  model: string,
  numCtx: number,
  temperature = 0.3,
  host = 'http://localhost:11434',
): Promise<string> {
  if (history.length === 0) return followUp

  const client = new Ollama({ host })
  const historyText = history
    .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n')

  const prompt = `Given the following conversation history and a follow-up question, rewrite the follow-up as a standalone question that captures all necessary context. Return ONLY the rewritten question, no explanation.

Conversation:
${historyText}

Follow-up: ${followUp}

Standalone question:`

  try {
    const res = await client.generate({
      model,
      prompt,
      options: { num_ctx: numCtx, temperature },  // num_ctx MUST be set
      stream: false,
    })
    return res.response.trim() || followUp
  } catch {
    return followUp  // graceful fallback: use original follow-up question
  }
}
