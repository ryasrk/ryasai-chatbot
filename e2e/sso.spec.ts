import { test, expect } from '@playwright/test'

/**
 * SSO UI spec — login view renders SSO buttons based on /api/auth/sso/status.
 * No real IdP needed — the status API is mocked.
 *
 * There is no /login route (the SPA renders LoginView at '/'); after the
 * setup-wizard spec completes, the DB is set up, so '/' shows LoginView for an
 * unauthenticated context automatically.
 */

/**
 * Shared: go to '/' and land on the LOGIN mode (the fresh-DB default renders
 * signup mode first, and SSO buttons only exist in login mode).
 */
async function gotoLoginMode(page: import('@playwright/test').Page) {
  await page.goto('/')
  // Wait for either state to settle: fresh DB renders the signup form (with
  // the toggle), completed DB renders login directly.
  await page.waitForLoadState('networkidle')
  const signupToggle = page.getByRole('button', { name: /Already have an account\? Sign in/i })
  const signin = page.getByRole('button', { name: 'Sign In', exact: true })
  const toggleVisible = await signupToggle.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false)
  if (toggleVisible) {
    await signupToggle.click()
  }
  await expect(signin).toBeVisible({ timeout: 10_000 })
}

test('shows no SSO buttons when status is all false', async ({ page }) => {
  await page.route('**/api/auth/sso/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, oidc: false, saml: false, configured: false }),
    })
  })

  await gotoLoginMode(page)
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

  await gotoLoginMode(page)
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

  await gotoLoginMode(page)
  await expect(page.getByText('Sign in with SSO')).not.toBeVisible()
  await expect(page.getByText('Sign in with SAML')).toBeVisible()
})

test('shows both buttons when both oidc and saml are true', async ({ page }) => {
  await page.route('**/api/auth/sso/status', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, oidc: true, saml: true, configured: true }),
    })
  })

  await gotoLoginMode(page)
  await expect(page.getByText('Sign in with SSO')).toBeVisible()
  await expect(page.getByText('Sign in with SAML')).toBeVisible()
})
