import { test, expect } from '@playwright/test'

/**
 * Setup wizard spec.
 * Runs first (fresh DB): register → activate license (mock validator) →
 * setup wizard (LLM config against the mock LLM) → Dashboard.
 *
 * Mirrors the CURRENT signup flow: register (name/email/password) is step 1,
 * license activation (org name optional + license key) is step 2 — the old
 * single-form signup with #orgName no longer exists.
 */
test('first run: register → activate license → setup wizard → dashboard', async ({ page }) => {
  await page.goto('/')

  // Step 1: Create Account
  await expect(page.getByText('Create Account')).toBeVisible()
  await page.locator('#name').fill('Admin E2E')
  await page.locator('#email').fill('admin@e2e.test')
  await page.locator('#password').fill('password123')
  await page.getByRole('button', { name: /Continue/i }).click()

  // Step 2: Activate License (mock validator signs a valid enterprise response)
  await expect(page.getByText('Activate License')).toBeVisible({ timeout: 10_000 })
  await page.locator('#orgName').fill('E2E Test Corp')
  await page.locator('#licenseKey').fill('RYASAI-278B49FD-641EF14A-265D68D3')
  await page.getByRole('button', { name: /Activate & Continue/i }).click()

  // Wizard step 1: LLM API — point at mock
  await expect(page.getByText('Setup Wizard — LLM API')).toBeVisible({ timeout: 15_000 })
  await page.locator('#llm-base').fill('http://localhost:4545/v1')
  await page.locator('#llm-key').fill('mock-key')
  await page.locator('#llm-model').fill('mock-model')
  await page.getByRole('button', { name: /Save & Continue|Continue/i }).click()

  // Wizard step 2: Test Model — skip
  await expect(page.getByText('Setup Wizard — Test Model')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /Skip/i }).click()

  // Wizard step 3: Document — skip
  await expect(page.getByText('Setup Wizard — Document')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /Skip/i }).click()

  // Wizard step 4: Data Source — acknowledge
  await expect(page.getByText('Setup Wizard — Data Source')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /Got it, Continue|Continue/i }).click()

  // Wizard step 5: Test Chat — finish
  await expect(page.getByText('Setup Wizard — Test Chat')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /Finish/i }).click()

  // Should land on the Dashboard
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
    timeout: 15_000,
  })
})
