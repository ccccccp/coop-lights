import { defineConfig } from '@playwright/test'
const baseURL = 'http://127.0.0.1:5198'
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 45000,
  use: {
    baseURL,
    viewport: { width: 1200, height: 1000 },
    browserName: 'chromium',
    channel: 'chrome',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm start',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      SERVER_PORT: '5198',
      ALLOWED_GAME_ORIGINS: baseURL,
      ENABLE_DEV_FAULTS: 'true',
    },
  },
})
