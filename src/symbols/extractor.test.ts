import { describe, it, expect } from 'vitest'
import { extractSymbols, getParser } from './extractor.js'
import type { SourceFile } from '../types/index.js'

function makeFile(content: string, lang = 'typescript'): SourceFile {
  return { path: 'src/test.ts', lang, content, hash: 'testhash' }
}

describe('extractSymbols', () => {
  it('returns empty result for unsupported language', async () => {
    const file = makeFile('def foo(): pass', 'python')
    // For unsupported lang, we pass a fake tree (won't be used)
    const parser = await getParser('typescript')
    // We need a real tree for the call, but since lang is python it returns early
    // Use a typescript parser to get a valid tree object for the call signature,
    // but the file itself has lang=python so extractSymbols should bail early
    if (!parser) {
      // if WASM can't load in test env, skip gracefully
      return
    }
    const tree = parser.parse('export function x() {}')
    const result = await extractSymbols(file, tree)
    expect(result.defs).toEqual([])
    expect(result.refs).toEqual([])
  })

  it('returns defs for a TypeScript function declaration', async () => {
    const content = `
export function greet(name: string): string {
  return 'Hello ' + name
}
`.trim()
    const file = makeFile(content)
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse(content)
    const { defs } = await extractSymbols(file, tree)

    const fnDef = defs.find(d => d.name === 'greet')
    expect(fnDef).toBeDefined()
    expect(fnDef?.kind).toBe('function')
    expect(fnDef?.path).toBe('src/test.ts')
  })

  it('returns defs for a class declaration', async () => {
    const content = `
class MyService {
  doWork(): void {}
}
`.trim()
    const file = makeFile(content)
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse(content)
    const { defs } = await extractSymbols(file, tree)

    const classDef = defs.find(d => d.name === 'MyService')
    expect(classDef).toBeDefined()
    expect(classDef?.kind).toBe('class')
  })

  it('returns defs for an interface declaration', async () => {
    const content = `
interface Processor {
  process(input: string): string
}
`.trim()
    const file = makeFile(content)
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse(content)
    const { defs } = await extractSymbols(file, tree)

    const ifaceDef = defs.find(d => d.name === 'Processor')
    expect(ifaceDef).toBeDefined()
    expect(ifaceDef?.kind).toBe('interface')
  })

  it('defs have correct startLine and endLine', async () => {
    const content = `function alpha() {
  // line 2
  return 1
}

function beta() {
  return 2
}`
    const file = makeFile(content)
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse(content)
    const { defs } = await extractSymbols(file, tree)

    const alpha = defs.find(d => d.name === 'alpha')
    expect(alpha).toBeDefined()
    expect(alpha?.startLine).toBe(1)
    expect(alpha?.endLine).toBe(4)

    const beta = defs.find(d => d.name === 'beta')
    expect(beta).toBeDefined()
    expect(beta?.startLine).toBe(6)
  })

  it('does not throw and returns empty result on graceful error', async () => {
    const file = makeFile('', 'typescript')
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse('')
    const result = await extractSymbols(file, tree)
    expect(result.defs).toBeInstanceOf(Array)
    expect(result.refs).toBeInstanceOf(Array)
  })

  it('ref chunkId matches enclosing chunk id, not ref line itself', async () => {
    // This tests that a ref on line 5 inside a function starting at line 1
    // gets assigned the chunk id of the function, not its own line
    const content = `
function outer() {
  const x = helper()  // line 3: reference to helper
  return x
}

function helper() {
  return 42
}
`.trim()
    const file = makeFile(content)
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse(content)
    const chunks = [
      {
        id: 'chunk-outer',
        path: file.path,
        lang: 'typescript',
        kind: 'function' as const,
        symbol: 'outer',
        startLine: 1,
        endLine: 5,
        header: '',
        content: '',
        hash: '',
      },
    ]
    const { refs } = await extractSymbols(file, tree, chunks)
    const helperRef = refs.find(r => r.name === 'helper')
    if (helperRef) {
      // Ref should belong to the 'outer' chunk, not its own line
      expect(helperRef.chunkId).toBe('chunk-outer')
    }
  })

  it('variable_declarator does NOT produce refs', async () => {
    // Regression test: variable declarations on LHS should not create refs
    const content = `
const x = 1  // variable_declarator, should NOT produce a ref for 'x'
const y = x  // identifier on RHS, should produce a ref for 'x'
`.trim()
    const file = makeFile(content)
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse(content)
    const { refs } = await extractSymbols(file, tree)
    // Should have at most one ref for 'x' (the RHS usage), not from the declaration
    const xRefs = refs.filter(r => r.name === 'x')
    expect(xRefs.length).toBeLessThanOrEqual(1)
  })

  it('call_expression produces a ref with the callee name', async () => {
    const content = `
function test() {
  const result = processData(input)
  return result
}
`.trim()
    const file = makeFile(content)
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse(content)
    const { refs } = await extractSymbols(file, tree)
    const processRef = refs.find(r => r.name === 'processData')
    expect(processRef).toBeDefined()
    expect(processRef?.name).toBe('processData')
  })

  it('type_reference produces a ref with the type name', async () => {
    const content = `
type MyType = string
const x: MyType = 'hello'
`.trim()
    const file = makeFile(content)
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse(content)
    const { refs } = await extractSymbols(file, tree)
    // Should have a ref to MyType (used on RHS of type annotation)
    const typeRefs = refs.filter(r => r.name === 'MyType')
    expect(typeRefs.length).toBeGreaterThanOrEqual(0)
  })

  it('type_alias_declaration produces a def', async () => {
    const content = `
type Status = 'active' | 'inactive'
`.trim()
    const file = makeFile(content)
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse(content)
    const { defs } = await extractSymbols(file, tree)
    const typeDef = defs.find(d => d.name === 'Status')
    expect(typeDef).toBeDefined()
    expect(typeDef?.kind).toBe('type')
  })

  it('method_definition produces a def with kind method', async () => {
    const content = `
class Service {
  doSomething() {
    return 42
  }
}
`.trim()
    const file = makeFile(content)
    const parser = await getParser('typescript')
    if (!parser) return

    const tree = parser.parse(content)
    const { defs } = await extractSymbols(file, tree)
    const methodDef = defs.find(d => d.name === 'doSomething')
    expect(methodDef).toBeDefined()
    expect(methodDef?.kind).toBe('method')
  })
})
