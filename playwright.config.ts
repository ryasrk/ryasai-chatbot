import { defineConfig } from '@playwright/test'
import { E2E_LICENSE_PUBKEY_HEX } from './e2e/mock-license-validator'

// Postgres-only schema — the e2e DB is a dedicated database, not a SQLite file.
const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai_e2e'

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1, // single shared DB — keep specs serial
  retries: 0,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3105',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `env DATABASE_URL=${E2E_DATABASE_URL} AUTH_DEMO_FALLBACK=false LICENSE_VALIDATOR_URL=http://localhost:4546 LICENSE_SIGNING_PUBLIC_KEY=${E2E_LICENSE_PUBKEY_HEX} LLM_ALLOW_BLOCKED_HOSTS=true PORT=3105 bun node_modules/.bin/next dev -p 3105`,
      url: 'http://localhost:3105/api/v1/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
