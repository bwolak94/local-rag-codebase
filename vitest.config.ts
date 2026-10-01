import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'eval/**/*.test.ts', 'test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
    coverage: {
      provider: 'v8',
      exclude: [
        'node_modules/**',
        '**/*.test.ts',
        '**/*.d.ts',
        'src/types/**',
        'dist/**',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
})
