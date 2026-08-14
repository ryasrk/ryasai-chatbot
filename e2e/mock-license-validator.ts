/**
 * Standalone License-Validator stub for the e2e suite.
 *
 * The real validator is a separate FastAPI service that signs responses with
 * Ed25519; the client fails CLOSED on a bad/missing signature, so an e2e stub
 * must actually sign. Uses a FIXED test-only keypair (committed): Playwright
 * loads playwright.config.ts BEFORE globalSetup runs, so a runtime-generated
 * key could never be injected into the webServer command's env in time. This
 * key is obviously not a production secret — it exists only so the e2e app
 * instance can verify the stub's signatures.
 *
 * Endpoints:
 *   POST /api/v1/license/validate → signed {valid, plan, expires_at, message}
 */
import http from 'http'
import crypto from 'crypto'

// Deterministic test keypair (DER hex). Test-only; never used in production.
export const E2E_LICENSE_PUBKEY_HEX =
  '302a300506032b657003210030d9afe8c7f308d2d4cbdb0749ca5f8829b5fd629e14ac837f39bcee53168e80'
const E2E_LICENSE_PRIVKEY_HEX =
  '302e020100300506032b6570042204209c969e5fa3b454cc4d7718cebcb07732e3c3671f66de8d533ba12cd3c7961832'

function privateKey(): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.from(E2E_LICENSE_PRIVKEY_HEX, 'hex'), format: 'der', type: 'pkcs8' })
}

export function startMockLicenseValidator(port = 4546): { server: http.Server } {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/license/validate')) {
      res.writeHead(404).end()
      return
    }

    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let nonce = ''
      try {
        nonce = (JSON.parse(raw) as { nonce?: string }).nonce ?? ''
      } catch {
        // mismatched nonce fails the client's verify — itself testable behavior
      }

      const payload = {
        valid: true,
        plan: 'enterprise',
        expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
        message: 'ok',
        nonce,
      }
      // Canonical JSON: sorted keys, no whitespace — must match the client's
      // JSON.stringify(payload, sortedKeys) reconstruction exactly.
      const canonical = JSON.stringify(payload, Object.keys(payload).sort())
      const signature = crypto.sign(null, Buffer.from(canonical), privateKey()).toString('hex')

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ...payload, signature }))
    })
  })

  server.listen(port)
  return { server }
}
