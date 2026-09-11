import { defineConfig } from '@playwright/test'
import { E2E_LICENSE_PUBKEY_HEX } from './e2e-keys'
import { E2E_MIDTRANS_SERVER_KEY } from './e2e/mock-midtrans'
import { E2E_LICENSE_INTERNAL_SECRET } from './e2e/mock-license-validator'

/**
 * Production-build e2e config — same specs, but against `bun run start`
 * (the standalone output) instead of `next dev`.
 *
 * WHY THIS EXISTS: every blocker found in the 2026-09 audit was discovered by
 * changing the environment, never by re-reading code. Until now the whole e2e
 * suite only ever ran under `next dev`, so nothing verified the artifact we
 * actually ship. Dev and a Turbopack/standalone build diverge in ways that are
 * invisible in dev and fatal in production:
 *
 *   - Server components are prerendered; `output: standalone` moves the tree.
 *   - Client code is minified, so any runtime error that stringifies differently
 *     (or relies on a dev-only global) behaves differently.
 *   - `serverExternalPackages` / `outputFileTracingIncludes` decide which
 *     packages exist at runtime — a missing DB driver or native module only
 *     fails here (invariants #3 documents a production-only driver outage).
 *   - NODE_ENV=production flips React to production mode and disables dev
 *     warnings that mask hydration mismatches.
 *   - The CSP / security headers in next.config apply for real.
 *
 * The app is built first (`bun run build`) and served with `bun run start`,
 * which is exactly the documented deployment command pair.
 *
 * Run: bun run build && bunx playwright test -c playwright.prod.config.ts
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai_e2e'

// Same env surface as the dev config, minus PORT (the start script reads it).
// NODE_ENV must be production so the standalone server runs in prod mode.
const E2E_ENV = [
  'NODE_ENV=production',
  `DATABASE_URL=${E2E_DATABASE_URL}`,
  'AUTH_DEMO_FALLBACK=false',
  'LICENSE_VALIDATOR_URL=http://localhost:4546',
  `LICENSE_SIGNING_PUBLIC_KEY=${E2E_LICENSE_PUBKEY_HEX}`,
  `MIDTRANS_SERVER_KEY=${E2E_MIDTRANS_SERVER_KEY}`,
  'MIDTRANS_IS_PRODUCTION=false',
  'MIDTRANS_BASE_URL=http://localhost:4547',
  'NEXT_PUBLIC_MIDTRANS_CLIENT_KEY=e2e-client-key',
  'NEXT_PUBLIC_MIDTRANS_IS_PRODUCTION=false',
  `LICENSE_INTERNAL_SECRET=${E2E_LICENSE_INTERNAL_SECRET}`,
  // ponytail: NODE_ENV=production normally REFUSES LLM_ALLOW_BLOCKED_HOSTS
  // (env-schema) because that flag disables the SSRF guard. The prod-build
  // suite legitimately needs it to reach the localhost mock LLM on :4545, so
  // it must set the explicit E2E_TEST_MODE opt-in. This is deliberately a
  // separate marker rather than a NODE_ENV inference — see the boot guard in
  // instrumentation.ts, which fails closed if it ever appears on a real deploy.
  'E2E_TEST_MODE=true',
  'LLM_ALLOW_BLOCKED_HOSTS=true',
  'PORT=3105',
].join(' ')

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:3105',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      // `bun run start` sources ./.env first, so the inline env must come
      // AFTER it on the command line to win. We bypass the npm script and
      // invoke the standalone server directly for exactly that reason.
      command: `env ${E2E_ENV} bun .next/standalone/server.js`,
      url: 'http://localhost:3105/api/v1/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
