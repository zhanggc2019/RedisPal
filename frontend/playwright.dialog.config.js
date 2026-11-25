import { defineConfig } from '@playwright/test'

/** Redis-free browser checks for the shared dialog's DOM and focus contract. */
export default defineConfig({
  testDir: './e2e',
  testMatch: ['dialog-contract.spec.js', 'key-editing.spec.js'],
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://127.0.0.1:5175',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
})
