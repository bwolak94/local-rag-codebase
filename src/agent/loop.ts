import { Ollama } from 'ollama'
import {
  SemanticSearchInput, GrepInput, ReadFileInput,
  FindSymbolInput, GetReferencesInput, ListDirInput,
  semanticSearch, grep, readFile, findSymbol, getReferences, listDir,
  type ToolContext,
} from './tools.js'
import type { ChatTurn } from '../types/index.js'
import type { RagConfig } from '../config/schema.js'

const MAX_STEPS = 8

// Tool definitions for Ollama tool-calling API
const OLLAMA_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'semantic_search',
      description: 'Hybrid vector + BM25 search over the indexed codebase.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          k: { type: 'number', description: 'Number of results (1-20)', default: 8 },
          path: { type: 'string', description: 'Restrict to files under this prefix (optional)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'grep',
      description: 'Exact pattern search via git grep.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex or literal pattern' },
          path: { type: 'string', description: 'Restrict to path prefix (optional)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file or line range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to repo root' },
          start: { type: 'number', description: 'Start line (1-indexed)' },
          end: { type: 'number', description: 'End line (1-indexed)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_symbol',
      description: 'Find all definitions of a symbol.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Symbol name' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_references',
      description: 'Find all usages of a symbol.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', description: 'Symbol name' } },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: 'List directory contents.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path relative to repo root' } },
        required: ['path'],
      },
    },
  },
]

type ToolCall = { name: string; arguments: Record<string, unknown> }

async function dispatchTool(call: ToolCall, ctx: ToolContext): Promise<string> {
  try {
    switch (call.name) {
      case 'semantic_search': return await semanticSearch(SemanticSearchInput.parse(call.arguments), ctx)
      case 'grep':            return await grep(GrepInput.parse(call.arguments), ctx)
      case 'read_file':       return readFile(ReadFileInput.parse(call.arguments), ctx)
      case 'find_symbol':     return await findSymbol(FindSymbolInput.parse(call.arguments), ctx)
      case 'get_references':  return await getReferences(GetReferencesInput.parse(call.arguments), ctx)
      case 'list_dir':        return listDir(ListDirInput.parse(call.arguments), ctx)
      default: return `Unknown tool: ${call.name}`
    }
  } catch (err) {
    // Zod parse error or tool execution error — return as tool result so LLM can recover
    return `Tool error (${call.name}): ${err instanceof Error ? err.message : String(err)}`
  }
}

export interface AgentResult {
  answer: string
  steps: number
  toolsUsed: string[]
}

export async function agentLoop(
  question: string,
  ctx: ToolContext,
  config: RagConfig,
  history: ChatTurn[] = [],
  host = 'http://localhost:11434',
): Promise<AgentResult> {
  const client = new Ollama({ host })

  const systemPrompt = `You are an expert software engineer with access to tools that can search and read a codebase.
Use the tools to gather the information needed to answer the question thoroughly.
When you have enough information, provide a final answer with citations in the format [path:startLine-endLine].
Do not call more than ${MAX_STEPS} tools total.`

  type Message = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string }
  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...history.map(t => ({ role: t.role as 'user' | 'assistant', content: t.content })),
    { role: 'user', content: question },
  ]

  const toolsUsed: string[] = []
  let steps = 0

  while (steps < MAX_STEPS) {
    let response: Awaited<ReturnType<typeof client.chat>>
    try {
      response = await client.chat({
        model: config.llm.model,
        messages,
        tools: OLLAMA_TOOLS,
        stream: false,
        options: { num_ctx: config.llm.numCtx, temperature: config.llm.temperature }, // num_ctx MUST be set
      })
    } catch (err) {
      // LLM or network error — graceful degradation: return what we have
      console.error('[agent] LLM error, degrading to plain answer:', err)
      break
    }

    // Each LLM response round counts as one step
    steps++

    const msg = response.message
    messages.push({ role: 'assistant', content: msg.content ?? '' })

    // If the model returned no tool calls, it's done
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return { answer: msg.content ?? '', steps, toolsUsed }
    }

    // Execute each tool call and push results
    for (const tc of msg.tool_calls) {
      const toolName = tc.function?.name ?? ''
      const rawArgs = tc.function?.arguments
      // Ollama SDK sometimes returns arguments as a JSON string — normalise to object
      const toolArgs: Record<string, unknown> =
        typeof rawArgs === 'string'
          ? (() => { try { return JSON.parse(rawArgs) as Record<string, unknown> } catch { return {} } })()
          : (rawArgs as Record<string, unknown> | undefined) ?? {}

      if (!toolName) continue  // skip malformed tool calls

      toolsUsed.push(toolName)
      const result = await dispatchTool({ name: toolName, arguments: toolArgs }, ctx)
      messages.push({ role: 'tool', content: result, name: toolName })
    }
  }

  // Graceful degradation: ask model to summarise with what it has
  try {
    messages.push({
      role: 'user',
      content: 'Based on the information gathered above, please provide your final answer.',
    })
    const final = await client.chat({
      model: config.llm.model,
      messages,
      stream: false,
      options: { num_ctx: config.llm.numCtx, temperature: config.llm.temperature }, // num_ctx MUST be set
    })
    return { answer: final.message.content ?? '', steps, toolsUsed }
  } catch {
    return { answer: 'Unable to generate an answer due to an error.', steps, toolsUsed }
  }
}
