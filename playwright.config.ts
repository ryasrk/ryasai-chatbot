import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

const E2E_DB_PATH = resolve(process.cwd(), 'db/e2e.db')

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1, // single shared sqlite db — keep specs serial
  retries: 0,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3105',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `env DATABASE_URL=file:${E2E_DB_PATH} AUTH_DEMO_FALLBACK=false PORT=3105 bun node_modules/.bin/next dev -p 3105`,
      url: 'http://localhost:3105/api/v1/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
