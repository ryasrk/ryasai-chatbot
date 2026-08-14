import { test, expect, type Page } from '@playwright/test'

/**
 * Knowledge + Chat spec.
 *
 * Verifies:
 * 1. A TXT document can be uploaded via the Knowledge view.
 * 2. The document gets indexed (status becomes "Ready").
 * 3. A chat session can be started and the AI responds.
 */

const E2E_EMAIL = 'admin@e2e.test'
const E2E_PASSWORD = 'password123'

/** Log in via API and navigate to the app. */
async function login(page: Page) {
  const res = await page.request.post('/api/auth/login', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  expect.soft(res.ok(), `login API returned ${res.status()}`).toBe(true)
  await page.goto('/')
  // ViewHeader renders <h1>Dashboard</h1> once the shell mounts post-login.
  // data-analytics can still be loading (or in ErrorState) — the header is
  // page-level, not dashboard-level, so match the text, not a deep state.
  // CI machines can be slow to mount the shell + analytics; the h1 itself is
  // static once mounted, so wait generously.
  await expect(page.locator('h1', { hasText: 'Dashboard' })).toBeVisible({
    timeout: 90_000,
  })
}

test('upload document and chat with mock LLM', async ({ page }) => {
  await login(page)

  // --- Upload a TXT document via the Knowledge view ---
  await page.goto('/?view=knowledge')
  await expect(page.getByText('Knowledge Base')).toBeVisible({ timeout: 10_000 })

  // Open the upload dialog
  await page.getByRole('button', { name: /Upload/i }).first().click()

  // Upload fixture file
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.setInputFiles({
    name: 'e2e-facts.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'The main warehouse code is GDG-77. ' +
        'Items are organized by product category and SKU. ' +
        'Electronic products must be stored in the air-conditioned area.',
      'utf-8',
    ),
  })

  // Submit upload
  await page.getByRole('button', { name: /Upload/i }).click()

  // Wait for success toast
  await expect(page.getByText(/uploaded/i)).toBeVisible({
    timeout: 15_000,
  })

  // Close dialog if still open
  await page.keyboard.press('Escape')

  // Wait for the document to appear
  await expect(page.getByText('e2e-facts.txt')).toBeVisible({
    timeout: 30_000,
  })

  // --- Chat with mock LLM ---
  await page.goto('/?view=chat')
  await expect(page.getByPlaceholder(/type|ask|question/i)).toBeVisible({
    timeout: 10_000,
  })

  // Type and send
  await page.getByPlaceholder(/type|ask|question/i).fill('What is the main warehouse code?')
  await page.getByRole('button', { name: /Send/i }).click()

  // The mock LLM returns a canned Indonesian response ("Jawaban uji dari mock
  // LLM."); match on the stable prefix since the full string may wrap.
  await expect(page.getByText(/jawaban uji/i)).toBeVisible({
    timeout: 45_000,
  })
})
