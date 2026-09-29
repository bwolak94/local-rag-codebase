import { describe, it, expect, vi, beforeEach } from 'vitest'
import { condensQuestion } from './rewrite.js'
import type { ChatTurn } from '../types/index.js'

// Mock the ollama package
const mockGenerate = vi.fn()

vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(() => ({
    generate: mockGenerate,
  })),
}))

describe('condensQuestion', () => {
  beforeEach(() => {
    mockGenerate.mockReset()
  })

  it('returns followUp unchanged when history is empty (no API call)', async () => {
    const result = await condensQuestion([], 'What is TypeScript?', 'qwen2.5-coder:14b', 32768)
    expect(result).toBe('What is TypeScript?')
    expect(mockGenerate).not.toHaveBeenCalled()
  })

  it('calls client.generate with history + followUp when history is non-empty', async () => {
    mockGenerate.mockResolvedValue({ response: 'What is the TypeScript compiler?' })

    const history: ChatTurn[] = [
      { role: 'user', content: 'Tell me about TypeScript' },
      { role: 'assistant', content: 'TypeScript is a typed superset of JavaScript.' },
    ]

    await condensQuestion(history, 'How does it compile?', 'qwen2.5-coder:14b', 32768)

    expect(mockGenerate).toHaveBeenCalledOnce()
    const callArgs = mockGenerate.mock.calls[0]?.[0]
    expect(callArgs).toBeDefined()
    expect(callArgs.model).toBe('qwen2.5-coder:14b')
    expect(callArgs.options.num_ctx).toBe(32768)
    expect(callArgs.options.temperature).toBe(0.3)  // default temperature
    expect(callArgs.prompt).toContain('Tell me about TypeScript')
    expect(callArgs.prompt).toContain('TypeScript is a typed superset of JavaScript.')
    expect(callArgs.prompt).toContain('How does it compile?')
  })

  it('forwards custom temperature to generate options', async () => {
    mockGenerate.mockResolvedValue({ response: 'rewritten' })

    const history: ChatTurn[] = [{ role: 'user', content: 'hi' }]
    await condensQuestion(history, 'follow-up', 'model', 32768, 0.7)

    const callArgs = mockGenerate.mock.calls[0]?.[0]
    expect(callArgs.options.temperature).toBe(0.7)
  })

  it('returns the trimmed LLM response', async () => {
    mockGenerate.mockResolvedValue({ response: '  How does the TypeScript compiler work?  ' })

    const history: ChatTurn[] = [
      { role: 'user', content: 'Explain TypeScript' },
      { role: 'assistant', content: 'It is a superset of JS.' },
    ]

    const result = await condensQuestion(history, 'How does it compile?', 'model', 32768)
    expect(result).toBe('How does the TypeScript compiler work?')
  })

  it('falls back to original followUp when LLM returns empty string', async () => {
    mockGenerate.mockResolvedValue({ response: '   ' })

    const history: ChatTurn[] = [
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous answer' },
    ]

    const result = await condensQuestion(history, 'my follow-up', 'model', 32768)
    expect(result).toBe('my follow-up')
  })

  it('formats history with User/Assistant labels', async () => {
    mockGenerate.mockResolvedValue({ response: 'standalone question' })

    const history: ChatTurn[] = [
      { role: 'user', content: 'user message' },
      { role: 'assistant', content: 'assistant reply' },
    ]

    await condensQuestion(history, 'follow-up', 'model', 32768)

    const callArgs = mockGenerate.mock.calls[0]?.[0]
    expect(callArgs.prompt).toContain('User: user message')
    expect(callArgs.prompt).toContain('Assistant: assistant reply')
  })

  it('sets stream: false in generate call', async () => {
    mockGenerate.mockResolvedValue({ response: 'rewritten' })

    const history: ChatTurn[] = [{ role: 'user', content: 'hi' }]
    await condensQuestion(history, 'follow', 'model', 32768)

    const callArgs = mockGenerate.mock.calls[0]?.[0]
    expect(callArgs.stream).toBe(false)
  })
})
