import { test, expect } from '@playwright/test'

/**
 * Auth spec — runs after setup-wizard.
 * The admin (admin@e2e.test / password123) was created by the signup flow.
 */

test('rejects wrong password, accepts correct, logs out', async ({ page }) => {
  await page.goto('/')

  // Should see the login form
  await expect(page.locator('#email')).toBeVisible()

  // Wrong password
  await page.locator('#email').fill('admin@e2e.test')
  await page.locator('#password').fill('wrong-password')
  await page.getByRole('button', { name: /Sign In/i }).click()

  // Error
  await expect(page.getByText(/Invalid email or password/i)).toBeVisible()

  // Correct password
  await page.locator('#password').fill('password123')
  await page.getByRole('button', { name: /Sign In/i }).click()

  // Dashboard
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
    timeout: 15_000,
  })

  // Logout
  await page.getByRole('button', { name: /Sign Out/i }).click()
  await expect(page.locator('#email')).toBeVisible({ timeout: 15_000 })
})
