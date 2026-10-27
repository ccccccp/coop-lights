import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/sdk',
  outputDir: './.sdk-test/results',
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: 'https://localhost:5190',
    browserName: 'chromium',
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1100 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm dev:sdk',
    url: 'https://localhost:5190/mock/health',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 45000,
    env: { SDK_TEST_ISOLATED: 'true', VITE_KOOK_HOST_ORIGINS: 'https://localhost:5190' },
  },
})
