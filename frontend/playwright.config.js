import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'desktop.spec.js',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
})
