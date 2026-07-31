import { NextRequest, NextResponse } from 'next/server'
import { handleApiError } from '@/lib/session'
import { isOidcConfigured, getOidcConfig, buildAuthUrl, generateStateNonce } from '@/lib/sso'

/**
 * GET /api/auth/sso/login
 *   Redirects to the OIDC provider's authorization endpoint.
 *   - 302 redirect to IdP when configured
 *   - 302 redirect back to /login?error=sso_not_configured when OIDC_* env vars missing
 *   Stores state + nonce in short-lived cookies for CSRF protection.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isOidcConfigured()) {
      return NextResponse.redirect(new URL('/login?error=sso_not_configured', req.url))
    }

    const issuer = process.env.OIDC_ISSUER!
    const config = await getOidcConfig(issuer)
    const { state, nonce } = generateStateNonce()
    const authUrl = buildAuthUrl(config, state, nonce)

    const res = NextResponse.redirect(authUrl, 302)
    res.cookies.set('sso_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 600,
      path: '/',
    })
    res.cookies.set('sso_nonce', nonce, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 600,
      path: '/',
    })
    return res
  } catch (e) {
    return handleApiError(e, 'Failed to initiate SSO login.')
  }
}
