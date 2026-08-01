import { test, expect } from '@playwright/test'

/**
 * Setup wizard spec.
 * Runs first (fresh DB) — signs up with license, walks through all
 * wizard steps, ending on the Dashboard.
 */
test('first run: signup with license → setup wizard → dashboard', async ({ page }) => {
  await page.goto('/')

  // Step 0: Signup (org + license + admin)
  await expect(page.getByText('Sign Up')).toBeVisible()
  await page.locator('#orgName').fill('E2E Test Corp')
  await page.locator('#slug').fill('e2e-test')
  await page.locator('#name').fill('Admin E2E')
  await page.locator('#email').fill('admin@e2e.test')
  await page.locator('#password').fill('password123')
  await page.locator('#licenseKey').fill('RYASAI-278B49FD-641EF14A-265D68D3')
  await page.getByRole('button', { name: /Create Organization/i }).click()

  // Step 1: LLM API — point at mock
  await expect(page.getByText('LLM API')).toBeVisible({ timeout: 10_000 })
  await page.locator('#llm-base').fill('http://localhost:4545/v1')
  await page.locator('#llm-key').fill('mock-key')
  await page.locator('#llm-model').fill('mock-model')
  await page.getByRole('button', { name: /Save & Continue/i }).click()

  // Step 2: Test Model — skip
  await expect(page.getByText('Test Model')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /Skip/i }).click()

  // Step 3: Document — skip
  await expect(page.getByText('Document')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /Skip/i }).click()

  // Step 4: Data Source — acknowledge
  await expect(page.getByText('Data Source')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /Got it, Continue/i }).click()

  // Step 5: Test Chat — finish
  await expect(page.getByText('Test Chat')).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /Finish/i }).click()

  // Should land on the Dashboard
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
    timeout: 15_000,
  })
})
