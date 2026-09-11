import { test, expect } from '@playwright/test'
import { Client } from 'pg'

/**
 * QRIS purchase flow — end to end.
 *
 * register (licenseless → org 'unpaid') → app locked with Buy License CTA →
 * buy dialog → 1-month pack → mock Snap "payment" → webhook settles →
 * dialog success → app unlocks → dashboard / chat / settings reachable.
 *
 * Mock stack (started by global-setup):
 *   :4545 mock LLM · :4546 mock License-Validator (also serves
 *   /internal/licenses/generate) · :4547 mock Midtrans Snap.
 *
 * Snap popup strategy: window.snap is stubbed via addInitScript (auto-"pays"
 * by calling the mock's settle endpoint). The dialog's loadSnap() checks
 * window.snap BEFORE appending the sandbox script tag, so no request to
 * app.sandbox.midtrans.com ever happens — least brittle option; serving a
 * local fake snap.js would still depend on NEXT_PUBLIC script URL wiring.
 *
 * Runs after the other specs alphabetically is NOT required: this spec seeds
 * its own org via the signup API and touches nothing owned by specs 01-05.
 */

const E2E_DB =
  process.env.E2E_DATABASE_URL ??
  'postgresql://ryasai:ryasai_dev@localhost:5432/ryasai_e2e'
const MIDTRANS_MOCK = 'http://localhost:4547'

test('QRIS purchase: unpaid signup → locked → buy 1-month pack → settled → unlocked', async ({
  page,
}) => {
  const unique = Date.now().toString(36)
  const email = `buyer-${unique}@e2e.test`
  const slug = `purchase-${unique}`
  const password = 'password123'

  // Auto-paying snap stub — fire-and-forget (no-cors) POST to the mock, which
  // holds the token→order map and posts a signed notification to the REAL app
  // webhook. Mirrors a customer scanning the QRIS code.
  await page.addInitScript(`
    window.snap = {
      pay: (token) => {
        void fetch('${MIDTRANS_MOCK}/__test/settle-by-token', {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ token }),
        })
      },
    }
  `)

  // 1. Register WITHOUT a license key → org starts licenseStatus='unpaid',
  //    session cookie lands in this browser context (page.request shares it).
  const res = await page.request.post('/api/auth/signup', {
    data: {
      organizationName: `Purchase Test ${unique}`,
      slug,
      name: 'Buyer E2E',
      email,
      password,
    },
  })
  expect(res.ok()).toBeTruthy()

  // 2. Provisioning nudge: mark setup completed for the new org. The wizard
  //    path in the UI is gated behind a valid plan, so an org that has both
  //    setupCompleted=true AND an unpaid license only exists after direct
  //    provisioning — exactly the state whose lockdown screen we're testing.
  const pg = new Client({ connectionString: E2E_DB })
  await pg.connect()
  await pg.query(
    `UPDATE "AppConfig" SET "setupCompleted" = true
     WHERE "organizationId" = (SELECT id FROM "Organization" WHERE slug = $1)`,
    [slug],
  )
  await pg.end()

  // 3. Locked shell: License Required + Buy License CTA (/api/me returns 402).
  await page.goto('/')
  await expect(page.getByText('License Required')).toBeVisible({ timeout: 20_000 })
  const cta = page.getByTestId('buy-license-cta')
  await expect(cta).toBeVisible()

  // 4. Open the buy dialog and pick the 1-month pack. The order creation calls
  //    the mock Snap (:4547); settlement is triggered from the NODE side below
  //    (browser-context fetches to the mock proved flaky/opaque under no-cors).
  const orderResponse = page.waitForResponse((r) =>
    r.url().includes('/api/billing/orders') && r.request().method() === 'POST',
  )
  await cta.click()
  const dialog = page.getByTestId('buy-license-dialog')
  await expect(dialog).toBeVisible()
  await page.getByTestId('buy-pack-1').click()
  const orderJson = (await (await orderResponse).json()) as {
    orderId: string
    token: string
  }
  expect(orderJson.orderId).toBeTruthy()
  expect(orderJson.token).toBeTruthy()

  // 5. Awaiting state renders, then the mock Midtrans "customer pays": post a
  //    correctly-signed settlement notification to the REAL app webhook.
  await expect(page.getByTestId('payment-awaiting')).toBeVisible()
  const settleRes = await page.request.post(`${MIDTRANS_MOCK}/__test/settle-by-token`, {
    data: { token: orderJson.token },
  })
  if (!settleRes.ok()) {
    throw new Error(
      `settle failed: ${settleRes.status()} ${await settleRes.text()}`,
    )
  }
  await expect(page.getByTestId('payment-settled')).toBeVisible({ timeout: 30_000 })

  // 6. Wait until license issuance (validator generate+validate) has landed —
  //    /api/me flips from 402 to 200 once org.licenseStatus is valid again.
  await expect(async () => {
    const me = await page.request.get('/api/me')
    expect(me.status()).toBe(200)
  }).toPass({ timeout: 20_000 })

  // 7. Reload into the unlocked shell and reach dashboard + chat.
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
    timeout: 20_000,
  })
  await page.locator('button[aria-label="Chat"]').click()
  await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible({
    timeout: 15_000,
  })

  // 8. Settings → Organization tab shows the subscription card.
  await page.locator('button[aria-label="Settings"]').click()
  await page.getByRole('tab', { name: /Organization/i }).click()
  await expect(page.getByText('License', { exact: true })).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByText('Status', { exact: true })).toBeVisible()
})
