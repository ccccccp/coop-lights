import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/server/tests/**/*.test.ts'],
    // 数据库和 TLS 集成用例限制并发，避免本机多服务环境下过量创建 worker。
    maxWorkers: 2,
    fileParallelism: false,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
})
