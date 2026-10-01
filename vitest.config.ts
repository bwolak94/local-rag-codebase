import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'eval/**/*.test.ts', 'test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
})
