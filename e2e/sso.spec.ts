import { test, expect } from '@playwright/test'

/**
 * SSO UI spec — tests that login buttons appear/disappear based on
 * /api/auth/sso/status response. No real IdP needed — we mock the status API.
 */

test('shows no SSO buttons when status is all false', async ({ page }) => {
  await page.route('**/api/auth/sso/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, oidc: false, saml: false, configured: false }),
    })
  })

  await page.goto('/login')
  await page.waitForTimeout(500)
  await expect(page.getByText('Sign In')).toBeVisible()
  await expect(page.getByText('Sign in with SSO')).not.toBeVisible()
  await expect(page.getByText('Sign in with SAML')).not.toBeVisible()
})

test('shows SSO button when oidc is true', async ({ page }) => {
  await page.route('**/api/auth/sso/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, oidc: true, saml: false, configured: true }),
    })
  })

  await page.goto('/login')
  await page.waitForTimeout(500)
  await expect(page.getByText('Sign in with SSO')).toBeVisible()
  await expect(page.getByText('Sign in with SAML')).not.toBeVisible()
})

test('shows SAML button when saml is true', async ({ page }) => {
  await page.route('**/api/auth/sso/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, oidc: false, saml: true, configured: true }),
    })
  })

  await page.goto('/login')
  await page.waitForTimeout(500)
  await expect(page.getByText('Sign in with SAML')).toBeVisible()
  await expect(page.getByText('Sign in with SSO')).not.toBeVisible()
})

test('shows both buttons when both oidc and saml are true', async ({ page }) => {
  await page.route('**/api/auth/sso/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, oidc: true, saml: true, configured: true }),
    })
  })

  await page.goto('/login')
  await page.waitForTimeout(500)
  await expect(page.getByText('Sign in with SSO')).toBeVisible()
  await expect(page.getByText('Sign in with SAML')).toBeVisible()
})
