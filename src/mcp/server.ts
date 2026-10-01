import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  SemanticSearchInput, GrepInput, ReadFileInput,
  FindSymbolInput, GetReferencesInput, ListDirInput,
  semanticSearch, grep, readFile, findSymbol, getReferences, listDir,
  type ToolContext,
} from '../agent/tools.js'
import type { RagConfig } from '../config/schema.js'

export function createMCPServer(config: RagConfig, ctx: ToolContext): Server {
  const server = new Server(
    { name: 'rag-local', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  const TOOLS = [
    {
      name: 'semantic_search',
      description: 'Hybrid vector + BM25 retrieval from the local code index using Reciprocal Rank Fusion.',
      inputSchema: zodToJsonSchema(SemanticSearchInput),
    },
    {
      name: 'grep',
      description: 'git grep over tracked source files. Use for exact identifier or pattern searches.',
      inputSchema: zodToJsonSchema(GrepInput),
    },
    {
      name: 'read_file',
      description: 'Read a specific line range from a file in the repository.',
      inputSchema: zodToJsonSchema(ReadFileInput),
    },
    {
      name: 'find_symbol',
      description: 'Look up all definitions of a symbol by name from the symbol index.',
      inputSchema: zodToJsonSchema(FindSymbolInput),
    },
    {
      name: 'get_references',
      description: 'Find all usages of a symbol across the codebase.',
      inputSchema: zodToJsonSchema(GetReferencesInput),
    },
    {
      name: 'list_dir',
      description: 'List directory contents with file types and sizes.',
      inputSchema: zodToJsonSchema(ListDirInput),
    },
  ]

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      let result: string
      switch (name) {
        case 'semantic_search':
          result = await semanticSearch(SemanticSearchInput.parse(args), ctx)
          break
        case 'grep':
          result = await grep(GrepInput.parse(args), ctx)
          break
        case 'read_file':
          result = readFile(ReadFileInput.parse(args), ctx)
          break
        case 'find_symbol':
          result = await findSymbol(FindSymbolInput.parse(args), ctx)
          break
        case 'get_references':
          result = await getReferences(GetReferencesInput.parse(args), ctx)
          break
        case 'list_dir':
          result = listDir(ListDirInput.parse(args), ctx)
          break
        default:
          throw new Error(`Unknown tool: ${name}`)
      }
      return { content: [{ type: 'text', text: result }] }
    } catch (err) {
      console.error(`[mcp] tool ${name} error:`, err)
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  })

  return server
}

export async function startMCPServer(config: RagConfig, ctx: ToolContext): Promise<void> {
  const server = createMCPServer(config, ctx)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // blocks until client disconnects
}

