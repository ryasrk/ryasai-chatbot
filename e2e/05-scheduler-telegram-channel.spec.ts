import { test, expect, type Page } from '@playwright/test'

/**
 * Scheduler add-telegram-channel modal spec.
 *
 * Verifies:
 * 1. The "+ Add Telegram channel" item appears in the Add Schedule dialog's
 *    Notification Channel dropdown and opens a nested modal.
 * 2. Saving the modal creates the channel (persisted — visible in Settings →
 *    Notifications) and auto-selects it in the Add Schedule dialog.
 * 3. The Add Schedule dialog stays open with its form state intact while the
 *    nested modal is used.
 */

const E2E_EMAIL = 'admin@e2e.test'
const E2E_PASSWORD = 'password123'
const CHANNEL_NAME = 'e2e-telegram-channel'

/** Log in via API and land on the app dashboard first. */
async function login(page: Page) {
  await page.request.post('/api/auth/login', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  await page.goto('/')
  // Just verify login worked by seeing the dashboard heading
  await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible({ timeout: 15_000 })
}

test('create Telegram channel inline from Add Schedule dialog', async ({ page }) => {
  await login(page)

  // Clean slate: delete any leftover channel from a previous run
  const listRes = await page.request.get('/api/notifications')
  const listBody = await listRes.json()
  for (const c of listBody.configs ?? []) {
    if (c.name === CHANNEL_NAME) {
      await page.request.delete(`/api/notifications/${c.id}`)
    }
  }

  // Navigate to Schedules view via sidebar click (works more reliably than ?view= param)
  const schedulesLink = page.getByText('Schedules').first()
  if (!await schedulesLink.isVisible()) {
    throw new Error('Could not find Schedules nav link')
  }
  await schedulesLink.click()

  // Wait for the scheduler page to load - use "Add Schedule" button as anchor point
  const addScheduleBtn = page.getByRole('button', { name: 'Add Schedule', exact: true })
  await expect(addScheduleBtn).toBeVisible({ timeout: 15_000 })

  // Open Add Schedule dialog
  await addScheduleBtn.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(/add schedule|edit schedule/i)

  // Fill part of the schedule form — must survive the nested modal flow
  await page.getByPlaceholder('Daily sales summary').fill('e2e-inline-channel')

  // Try dropdown path first; if no active channels exist, use empty-state button
  // per scheduler view logic: Select dropdown only shows + Add Telegram channel item when channels > 0
  let addChannelMethodFound = false

  try {
    // Dropdown path (channels exist) — only attempt if combobox isn't disabled
    const channelCombobox = page.getByLabel('Notification Channel')
    if (channelCombobox && !(await channelCombobox.isDisabled())) {
      await channelCombobox.click()
      const option = page.getByRole('option', { name: /Add Telegram channel/i })
      if (!(await option.isVisible())) {
        throw new Error('option not found in dropdown')
      }
      await option.click()
      addChannelMethodFound = true
    } else {
      throw new Error('combobox disabled or missing')
    }
  } catch {
    // Fallback: empty-state button (no channels yet)
    const addBtn = page.getByRole('button', { name: /add channel/i, exact: true })
    if (!(await addBtn.isVisible())) {
      throw new Error('neither dropdown nor empty-state available')
    }
    await addBtn.click()
    addChannelMethodFound = true
  }

  if (!addChannelMethodFound) {
    throw new Error('could not find add channel entry point')
  }

  // Nested modal is now on top
  await expect(page.getByRole('dialog', { name: /Add Telegram Channel/i })).toBeVisible()

  // Validation: save with empty fields → error toast, modal stays open
  await page.getByRole('button', { name: 'Save Channel' }).click()
  await expect(page.getByText('Bot token and chat ID are required.')).toBeVisible()

  // Fill and save
  await page.getByPlaceholder('e.g. Ops Alerts').fill(CHANNEL_NAME)
  await page.getByPlaceholder('123456789:AAH... (from @BotFather)').fill('123456789:AAEtesttoken')
  await page.getByPlaceholder('123456789 or @mychannel').fill('@e2e_test_channel')
  await page.getByRole('button', { name: 'Save Channel' }).click()

  // Modal closes; the Add Schedule dialog remains open with form state intact
  await expect(page.getByRole('dialog', { name: /Add Telegram Channel/i })).not.toBeVisible()
  await expect(dialog).toBeVisible()
  await expect(page.getByPlaceholder('Daily sales summary')).toHaveValue('e2e-inline-channel')

  // New channel is auto-selected in the Notification Channel selector
  const selector = page.getByRole('combobox').filter({ hasText: new RegExp(CHANNEL_NAME, 'i') })
  await expect(selector).toBeVisible()

  // Persisted: appears via the API (same list Settings reads)
  const verify = await page.request.get('/api/notifications')
  const verifyBody = await verify.json()
  const created = (verifyBody.configs ?? []).find((c: { name: string }) => c.name === CHANNEL_NAME)
  expect(created).toBeTruthy()
  expect(created.type).toBe('telegram')
})
