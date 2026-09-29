#!/usr/bin/env node
import { program } from 'commander'

program
  .name('rag')
  .description('Local RAG for source code — powered by Ollama')
  .version('0.1.0')

await Promise.all([
  import('./ask.js').then(m => m.register(program)),
  import('./index-cmd.js').then(m => m.register(program)),
  import('./watch.js').then(m => m.register(program)),
  import('./serve-mcp.js').then(m => m.register(program)),
  import('./chat.js').then(m => m.register(program)),
])

program.parseAsync(process.argv).catch(err => {
  console.error(err)
  process.exit(1)
})
