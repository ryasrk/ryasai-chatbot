import { test, expect, type Page } from '@playwright/test'

/**
 * External API key spec.
 *
 * Verifies:
 * 1. An API key can be created via the API.
 * 2. /api/v1/chat/completions works with a valid Bearer key.
 * 3. /api/v1/chat/completions rejects requests without a key (401).
 */

const E2E_EMAIL = 'admin@e2e.test'
const E2E_PASSWORD = 'password123'

/** Log in via API and return the page with an active session. */
async function login(page: Page) {
  await page.request.post('/api/auth/login', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
    timeout: 15_000,
  })
}

test('create API key and use it for external chat completions', async ({
  page,
}) => {
  await login(page)

  // --- Create an API key via API ---
  const createRes = await page.request.post('/api/settings/api-keys', {
    data: {
      label: 'e2e-test-key',
      requestLimitPerMinute: 60,
      dailyRequestLimit: 1000,
    },
  })
  expect(createRes.ok()).toBeTruthy()
  const createBody = await createRes.json()
  const apiKey: string = createBody.apiKey
  expect(apiKey).toBeTruthy()
  expect(apiKey.length).toBeGreaterThan(10)

  // --- Use the key for chat completions ---
  const chatRes = await page.request.post('/api/v1/chat/completions', {
    headers: { Authorization: `Bearer ${apiKey}` },
    data: {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Halo, siapa kamu?' }],
    },
  })
  expect(chatRes.status()).toBe(200)
  const chatBody = await chatRes.json()
  // Non-stream endpoint returns { answer, citations, session_id, ... }
  expect(chatBody.answer).toBeTruthy()

  // --- Without a key → 401 ---
  const noKeyRes = await page.request.post('/api/v1/chat/completions', {
    data: {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'test' }],
    },
  })
  expect(noKeyRes.status()).toBe(401)

  // --- With a bogus key → 401 ---
  const badKeyRes = await page.request.post('/api/v1/chat/completions', {
    headers: { Authorization: 'Bearer bogus-key-12345' },
    data: {
      model: 'mock-model',
      messages: [{ role: 'user', content: 'test' }],
    },
  })
  expect(badKeyRes.status()).toBe(401)
})
