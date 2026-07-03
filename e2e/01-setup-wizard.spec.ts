import { test, expect } from '@playwright/test'

/**
 * Setup wizard spec.
 * Runs first (fresh DB) — creates the admin account and walks through all
 * wizard steps, ending on the Dashboard.
 */
test('first run: setup wizard creates admin and completes', async ({ page }) => {
  await page.goto('/')

  // Step 0: Admin account
  await expect(page.getByText('Setup Awal')).toBeVisible()
  await page.locator('#setup-name').fill('Admin E2E')
  await page.locator('#setup-email').fill('admin@e2e.test')
  await page.locator('#setup-password').fill('password123')
  await page.getByRole('button', { name: 'Buat Akun & Lanjut' }).click()

  // Step 1: LLM API — point at mock
  await expect(page.getByText('LLM API')).toBeVisible()
  await page.locator('#llm-base').fill('http://localhost:4545/v1')
  await page.locator('#llm-key').fill('mock-key')
  await page.locator('#llm-model').fill('mock-model')
  await page.getByRole('button', { name: 'Simpan & Lanjut' }).click()

  // Step 2: Test Model — sync models then proceed
  await expect(page.getByText('Tes Model')).toBeVisible()
  await page.getByRole('button', { name: 'Tes Koneksi' }).click()
  await expect(page.getByText(/model tersedia/i)).toBeVisible()
  await page.getByRole('button', { name: 'Lanjut →' }).click()

  // Step 3: Document — skip
  await expect(page.getByText('Setup Awal — Dokumen')).toBeVisible()
  await page.getByRole('button', { name: 'Lewati' }).click()

  // Step 4: Data Source — acknowledge
  await expect(page.getByText('Setup Awal — Data Source')).toBeVisible()
  await page.getByRole('button', { name: /Mengerti, Lanjut/i }).click()

  // Step 5: Test Chat — send a test message then finish
  await expect(page.getByText('Tes Chat')).toBeVisible()
  await page.locator('#test-msg').fill('Halo, ini tes.')
  await page.getByRole('button', { name: 'Kirim Tes' }).click()
  await expect(page.getByText('Balasan:')).toBeVisible()

  await page.getByRole('button', { name: 'Selesai' }).click()

  // Should land on the Dashboard
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
    timeout: 15_000,
  })
})
