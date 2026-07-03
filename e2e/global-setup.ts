/**
 * Playwright global setup.
 *
 * Runs the e2e DB seed, then starts the mock LLM server. The mock LLM runs
 * for the entire test run and is stopped on teardown.
 */
import { execSync } from 'child_process'
import { startMockLlm } from './mock-llm'
import type { Server } from 'http'

export default async function globalSetup() {
  console.log('\n[global-setup] Seeding e2e database…')
  execSync('bun run scripts/e2e-seed.ts', {
    stdio: 'inherit',
    cwd: process.cwd(),
  })

  console.log('[global-setup] Starting mock LLM on :4545…')
  const server: Server = startMockLlm(4545)

  return async () => {
    console.log('\n[global-setup] Stopping mock LLM…')
    return new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
}
