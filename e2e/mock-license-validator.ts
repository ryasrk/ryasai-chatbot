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
 *   POST /api/v1/license/validate      → signed {valid, plan, expires_at, message}
 *   POST /internal/licenses/generate   → {licenseKey, expiresAt} — used by the
 *     app's webhook settlement handler (X-Internal-Secret auth). Issued keys
 *     land in a registry; /validate reports their real expiry + 'flat' plan.
 *     Unregistered keys are still accepted (the stub predates billing and the
 *     setup-wizard spec activates a hardcoded key) — the registry only makes
 *     issued keys resolve to their true expiry instead of +365d.
 */
import http from 'http'
import crypto from 'crypto'

/** Fixed test-only internal secret — global-setup sets the same value on the app. */
export const E2E_LICENSE_INTERNAL_SECRET = 'e2e-internal-secret'

interface IssuedLicense {
  licenseKey: string
  plan: string
  expiresAt: string
}

const issuedKeys = new Map<string, IssuedLicense>()

// Keypair lives in ../e2e-keys (importable by playwright.config without
// dragging playwright types into the production build).
const E2E_LICENSE_PRIVKEY_HEX =
  '302e020100300506032b6570042204209c969e5fa3b454cc4d7718cebcb07732e3c3671f66de8d533ba12cd3c7961832'

function privateKey(): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.from(E2E_LICENSE_PRIVKEY_HEX, 'hex'), format: 'der', type: 'pkcs8' })
}

export function startMockLicenseValidator(port = 4546): { server: http.Server } {
  const server = http.createServer((req, res) => {
    // --- internal license generation (webhook settlement path) ---
    if (req.method === 'POST' && req.url?.includes('/internal/licenses/generate')) {
      if (req.headers['x-internal-secret'] !== E2E_LICENSE_INTERNAL_SECRET) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid internal secret' }))
        return
      }
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let slug = ''
        let months = 1
        try {
          const body = JSON.parse(raw) as { slug?: string; months?: number }
          slug = body.slug ?? ''
          months = Number(body.months) > 0 ? Number(body.months) : 1
        } catch {
          /* handled below */
        }
        if (!slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'slug is required' }))
          return
        }
        const licenseKey = `RYASAI-E2E-${slug.slice(0, 12).toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`
        const expiresAt = new Date(Date.now() + months * 31 * 24 * 3600 * 1000).toISOString()
        issuedKeys.set(licenseKey, { licenseKey, plan: 'flat', expiresAt })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ licenseKey, expiresAt }))
      })
      return
    }

    if (req.method !== 'POST' || !req.url?.includes('/license/validate')) {
      res.writeHead(404).end()
      return
    }

    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let nonce = ''
      let licenseKey = ''
      try {
        // The app's client sends snake_case (license_key) — see license-client.ts.
        const body = JSON.parse(raw) as { nonce?: string; license_key?: string }
        nonce = body.nonce ?? ''
        licenseKey = body.license_key ?? ''
      } catch {
        // mismatched nonce fails the client's verify — itself testable behavior
      }

      // Issued keys resolve to their real expiry + plan; anything else keeps
      // the stub's original always-valid behavior (+365d enterprise).
      const issued = issuedKeys.get(licenseKey)
      const payload = {
        valid: true,
        plan: issued?.plan ?? 'enterprise',
        expires_at: issued?.expiresAt ?? new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
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
