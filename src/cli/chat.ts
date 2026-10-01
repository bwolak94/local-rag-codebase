import { Command } from 'commander'
import * as readline from 'node:readline'
import { loadConfig } from '../config/loader.js'
import { createEmbedder } from '../embedding/factory.js'
import { createStore } from '../store/factory.js'
import { SQLiteSymbolIndex } from '../symbols/index.js'
import { HybridRetriever } from '../retrieval/hybrid.js'
import { OllamaGenerator } from '../generation/chat.js'
import { condensQuestion } from '../retrieval/rewrite.js'
import { allocateBudget } from '../generation/budget.js'
import type { ChatTurn } from '../types/index.js'

const MAX_HISTORY_TURNS = 10

export function register(program: Command) {
  program
    .command('chat')
    .description('Interactive multi-turn REPL with conversation history')
    .option('--config <path>', 'Path to .ragconfig.json')
    .option('--no-rewrite', 'Disable question condensation for follow-ups')
    .action(async (opts) => {
      const config = loadConfig({}, opts.config)
      const embedder = createEmbedder(config)
      const store = createStore(config)
      const symbolIndex = new SQLiteSymbolIndex(config.store.path, config.root)
      const { contextTokens } = allocateBudget(
        config.llm.numCtx,
        config.budget.contextFraction,
        config.budget.historyFraction,
      )
      const retriever = new HybridRetriever(
        store,
        embedder,
        {
          kVector: config.retrieval.kVector,
          kFts: config.retrieval.kFts,
          symbolIndex,
          expandMaxTokens: contextTokens,
          expandDepth: config.retrieval.expandDepth,
        },
        config,
      )
      const generator = new OllamaGenerator(config, config.llm.host)
      const history: ChatTurn[] = []

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      })

      console.log('RAG Chat — type your question, "exit" or Ctrl+C to quit\n')

      const ask = (): void => {
        rl.question('> ', async (input) => {
          const question = input.trim()

          if (!question) { ask(); return }
          if (question.toLowerCase() === 'exit') { rl.close(); return }

          try {
            // condense follow-up questions for better retrieval
            // --no-rewrite flag (opts.rewrite === false) overrides config; config default is also respected
            const useRewrite = opts.rewrite !== false && config.retrieval.rewrite
            const retrievalQuery = (useRewrite && history.length > 0)
              ? await condensQuestion(history, question, config.llm.model, config.llm.numCtx, config.llm.rewriteTemperature)
              : question

            const context = await retriever.retrieve(retrievalQuery, {
              k: config.retrieval.kFinal,
              expand: config.retrieval.expandDepth > 0,
            })

            process.stdout.write('\n')
            let answer = ''
            for await (const token of generator.answer(question, context, history)) {
              process.stdout.write(token)
              answer += token
            }
            process.stdout.write('\n\n')

            // update history, keep last MAX_HISTORY_TURNS turns
            history.push({ role: 'user', content: question })
            history.push({ role: 'assistant', content: answer })
            if (history.length > MAX_HISTORY_TURNS * 2) {
              history.splice(0, 2) // remove oldest user+assistant pair
            }
          } catch (err) {
            console.error('[chat] error:', err)
          }

          ask()
        })
      }

      rl.on('close', () => { console.log('\nBye.'); process.exit(0) })
      ask()
    })
}
