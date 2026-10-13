import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['apps/server/tests/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
})
