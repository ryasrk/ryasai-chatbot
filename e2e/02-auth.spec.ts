import { test, expect } from '@playwright/test'

/**
 * Auth spec — runs after setup-wizard.
 * The admin (admin@e2e.test / password123) was created by the wizard.
 */

test('rejects wrong password, accepts correct, logs out', async ({ page }) => {
  await page.goto('/')

  // Should see the login form (the email field is unique to the login screen)
  await expect(page.locator('#email')).toBeVisible()
  await expect(page.getByText('kredensial admin')).toBeVisible()

  // Wrong password
  await page.locator('#email').fill('admin@e2e.test')
  await page.locator('#password').fill('wrong-password')
  await page.getByRole('button', { name: 'Masuk' }).click()

  // Error alert (be specific: Next.js route announcer also has role="alert")
  await expect(page.getByText('Email atau password salah.')).toBeVisible()

  // Correct password
  await page.locator('#password').fill('password123')
  await page.getByRole('button', { name: 'Masuk' }).click()

  // Dashboard
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
    timeout: 15_000,
  })

  // Logout
  await page.getByRole('button', { name: 'Keluar' }).click()
  // Back to login form
  await expect(page.locator('#email')).toBeVisible({ timeout: 15_000 })
})
