import { z } from 'zod'

export const RagConfigSchema = z.object({
  root: z.string().default('.').describe('Repository root path'),
  include: z.array(z.string()).default(['src/**']).describe('Glob patterns to include'),
  exclude: z.array(z.string()).default([
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/*.lock',
    '**/go.sum',
    '**/Cargo.lock',
  ]).describe('Glob patterns to exclude'),
  maxFileBytes: z.number().default(200_000).describe('Skip files larger than this'),
  embedding: z.object({
    model: z.string().default('nomic-embed-text'),
    batchSize: z.number().default(48),
  }).default({}),
  llm: z.object({
    model: z.string().default('qwen2.5-coder:14b'),
    numCtx: z.number().default(32768),
    temperature: z.number().default(0.1),
    rewriteTemperature: z.number().default(0.3),
  }).default({}),
  retrieval: z.object({
    kVector: z.number().default(20),
    kFts: z.number().default(20),
    kFinal: z.number().default(8),
    expandDepth: z.number().default(1),
    rewrite: z.boolean().default(false),
    rerank: z.enum(['false', 'llm', 'cross-encoder']).default('false'),
  }).default({}),
  store: z.object({
    driver: z.enum(['lancedb', 'sqlite']).default('lancedb'),
    path: z.string().default('.rag'),
  }).default({}),
  budget: z.object({
    contextFraction: z.number().default(0.60),
    historyFraction: z.number().default(0.20),
  }).default({}),
})

export type RagConfig = z.infer<typeof RagConfigSchema>
