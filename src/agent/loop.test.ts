import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatTurn, Retriever, SymbolIndex } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'
import type { ToolContext } from './tools.js'

// ── Mock ollama ─────────────────────────────────────────────────────────────

const mockChat = vi.fn()

vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(() => ({
    chat: mockChat,
  })),
}))

// ── Import SUT after mocks ───────────────────────────────────────────────────

import { agentLoop } from './loop.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<RagConfig['llm']> = {}): RagConfig {
  return {
    root: '.',
    include: ['src/**'],
    exclude: [],
    maxFileBytes: 200_000,
    embedding: { model: 'nomic-embed-text', batchSize: 48 },
    llm: {
      model: 'qwen2.5-coder:14b',
      numCtx: 32768,
      temperature: 0.1,
      rewriteTemperature: 0.3,
      ...overrides,
    },
    retrieval: {
      kVector: 20,
      kFts: 20,
      kFinal: 8,
      expandDepth: 1,
      rewrite: false,
      rerank: 'false',
    },
    store: { driver: 'lancedb', path: '.rag' },
    budget: { contextFraction: 0.6, historyFraction: 0.2 },
  } as RagConfig
}

function makeCtx(): ToolContext {
  const retriever: Retriever = {
    retrieve: vi.fn().mockResolvedValue([]),
  }
  const symbolIndex: SymbolIndex = {
    upsert: vi.fn().mockResolvedValue(undefined),
    deleteByPath: vi.fn().mockResolvedValue(undefined),
    definitions: vi.fn().mockResolvedValue([]),
    references: vi.fn().mockResolvedValue([]),
    neighbors: vi.fn().mockResolvedValue([]),
  }
  return { retriever, symbolIndex, root: '/repo' }
}

// A chat response with no tool calls — final answer
function finalResponse(content: string) {
  return {
    message: { role: 'assistant', content, tool_calls: undefined },
  }
}

// A chat response with one tool call
function toolCallResponse(toolName: string, args: Record<string, unknown>) {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: toolName, arguments: args } }],
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('agentLoop', () => {
  beforeEach(() => {
    mockChat.mockReset()
  })

  it('returns answer and steps: 0 when LLM returns no tool calls immediately', async () => {
    mockChat.mockResolvedValueOnce(finalResponse('The answer is 42.'))

    const result = await agentLoop('What is the answer?', makeCtx(), makeConfig())

    expect(result.answer).toBe('The answer is 42.')
    expect(result.steps).toBe(0)
    expect(result.toolsUsed).toEqual([])
  })

  it('executes a tool call, adds result to messages, then returns final answer', async () => {
    // First call: model requests semantic_search
    mockChat.mockResolvedValueOnce(toolCallResponse('semantic_search', { query: 'rrf function', k: 5 }))
    // Second call: model has tool result, returns answer
    mockChat.mockResolvedValueOnce(finalResponse('The rrf function is in rrf.ts.'))

    const result = await agentLoop('Where is rrf defined?', makeCtx(), makeConfig())

    expect(result.answer).toBe('The rrf function is in rrf.ts.')
    expect(result.steps).toBe(1)
    expect(result.toolsUsed).toEqual(['semantic_search'])
  })

  it('stops after MAX_STEPS (8) and calls the degradation summary', async () => {
    // The loop does one chat call per iteration of the while loop.
    // Each call returns a tool call → 1 step consumed.
    // After 8 steps the while exits and the degradation chat call is made.
    // So we need exactly 8 tool-call responses + 1 final-answer response.
    const toolResp = toolCallResponse('list_dir', { path: '.' })
    for (let i = 0; i < 8; i++) {
      mockChat.mockResolvedValueOnce(toolResp)
    }
    // 9th chat call = degradation summary
    mockChat.mockResolvedValueOnce(finalResponse('Degraded answer.'))

    const result = await agentLoop('List everything', makeCtx(), makeConfig())

    expect(result.answer).toBe('Degraded answer.')
    expect(result.steps).toBe(8)
    expect(result.toolsUsed.filter(t => t === 'list_dir').length).toBe(8)
  })

  it('returns tool error string (not thrown) when Zod validation fails', async () => {
    // grep requires 'pattern' field — pass empty object to force Zod error
    mockChat.mockResolvedValueOnce(toolCallResponse('grep', {}))
    // After tool error result is pushed, model returns final answer
    mockChat.mockResolvedValueOnce(finalResponse('Handled Zod error.'))

    const result = await agentLoop('Grep something', makeCtx(), makeConfig())

    // The loop must not throw — it must return an AgentResult
    expect(result.answer).toBe('Handled Zod error.')
    expect(result.steps).toBe(1)
    expect(result.toolsUsed).toEqual(['grep'])
  })

  it('returns unknown tool error string (not thrown) for unrecognised tool name', async () => {
    mockChat.mockResolvedValueOnce(toolCallResponse('fly_to_moon', { destination: 'moon' }))
    mockChat.mockResolvedValueOnce(finalResponse('Unknown tool handled.'))

    const result = await agentLoop('Do something', makeCtx(), makeConfig())

    expect(result.answer).toBe('Unknown tool handled.')
    expect(result.toolsUsed).toEqual(['fly_to_moon'])
    expect(result.steps).toBe(1)
  })

  it('triggers graceful degradation when LLM throws on first call', async () => {
    // First call throws a network error
    mockChat.mockRejectedValueOnce(new Error('network error'))
    // Degradation summary call succeeds
    mockChat.mockResolvedValueOnce(finalResponse('Fallback answer.'))

    const result = await agentLoop('Any question?', makeCtx(), makeConfig())

    // Must not throw — returns AgentResult with degradation answer
    expect(result.answer).toBe('Fallback answer.')
    expect(result.steps).toBe(0)
  })

  it('returns "Unable to generate an answer" when degradation call also fails', async () => {
    // Initial call throws
    mockChat.mockRejectedValueOnce(new Error('LLM down'))
    // Degradation summary call also throws
    mockChat.mockRejectedValueOnce(new Error('still down'))

    const result = await agentLoop('Any question?', makeCtx(), makeConfig())

    expect(result.answer).toBe('Unable to generate an answer due to an error.')
    expect(result.steps).toBe(0)
  })

  it('lists all tools called in order in toolsUsed', async () => {
    // Step 1: list_dir
    mockChat.mockResolvedValueOnce(toolCallResponse('list_dir', { path: 'src' }))
    // Step 2: grep
    mockChat.mockResolvedValueOnce(toolCallResponse('grep', { pattern: 'HybridRetriever' }))
    // Step 3: read_file — then final answer
    mockChat.mockResolvedValueOnce(toolCallResponse('read_file', { path: 'src/retrieval/hybrid.ts' }))
    // Final answer
    mockChat.mockResolvedValueOnce(finalResponse('Done.'))

    const result = await agentLoop('Explore hybrid retriever', makeCtx(), makeConfig())

    expect(result.toolsUsed).toEqual(['list_dir', 'grep', 'read_file'])
    expect(result.steps).toBe(3)
  })

  it('prepends history turns to the message list before the user question', async () => {
    mockChat.mockResolvedValueOnce(finalResponse('Answer with history.'))

    const history: ChatTurn[] = [
      { role: 'user', content: 'What is TypeScript?' },
      { role: 'assistant', content: 'A typed superset of JavaScript.' },
    ]

    await agentLoop('How does it compile?', makeCtx(), makeConfig(), history)

    const callArgs = mockChat.mock.calls[0]?.[0]
    expect(callArgs).toBeDefined()
    // messages[0] = system, messages[1] = user history, messages[2] = assistant history, messages[3] = current question
    const messages = callArgs.messages as Array<{ role: string; content: string }>
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]?.role).toBe('user')
    expect(messages[1]?.content).toBe('What is TypeScript?')
    expect(messages[2]?.role).toBe('assistant')
    expect(messages[2]?.content).toBe('A typed superset of JavaScript.')
    expect(messages[3]?.role).toBe('user')
    expect(messages[3]?.content).toBe('How does it compile?')
  })

  it('always passes num_ctx in every Ollama call options', async () => {
    mockChat.mockResolvedValueOnce(toolCallResponse('list_dir', { path: '.' }))
    mockChat.mockResolvedValueOnce(finalResponse('Done.'))

    const config = makeConfig()
    await agentLoop('Test num_ctx', makeCtx(), config)

    for (const call of mockChat.mock.calls) {
      const args = call[0] as { options?: { num_ctx?: number } }
      expect(args.options?.num_ctx).toBe(config.llm.numCtx)
    }
  })

  it('passes multiple tool calls from a single response in order', async () => {
    // Model returns two tool calls in one response
    mockChat.mockResolvedValueOnce({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'list_dir', arguments: { path: '.' } } },
          { function: { name: 'find_symbol', arguments: { name: 'HybridRetriever' } } },
        ],
      },
    })
    mockChat.mockResolvedValueOnce(finalResponse('Summarised.'))

    const result = await agentLoop('Multi tool call', makeCtx(), makeConfig())

    expect(result.toolsUsed).toEqual(['list_dir', 'find_symbol'])
    expect(result.steps).toBe(2)
  })
})
