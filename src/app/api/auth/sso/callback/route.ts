import { NextRequest, NextResponse } from 'next/server'
import { handleApiError, writeAudit } from '@/lib/session'
import {
  isOidcConfigured,
  getOidcConfig,
  exchangeCode,
  decodeIdToken,
  verifyIdToken,
  verifyIdTokenRs256,
  fetchUserInfo,
  getOrCreateSsoUser,
} from '@/lib/sso'

/**
 * GET /api/auth/sso/callback?code=...&state=...
 *   OIDC callback — exchanges code for tokens, verifies id_token, creates/updates
 *   user, sets session cookie. Redirects to / on success, /login on error.
 *
 *   - Validates state cookie against query param (CSRF)
 *   - Verifies id_token (HS256 sync or RS256 async via JWKS)
 *   - Fetches userinfo if endpoint exists (else uses id_token claims)
 *   - getOrCreateSsoUser: finds by ssoSubject, then email, else creates
 */
export async function GET(req: NextRequest) {
  try {
    if (!isOidcConfigured()) {
      return NextResponse.json({ error: 'SSO not configured.' }, { status: 400 })
    }

    const { searchParams } = new URL(req.url)
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const stateCookie = req.cookies.get('sso_state')?.value
    const nonceCookie = req.cookies.get('sso_nonce')?.value

    if (!code || !state || !stateCookie) {
      return NextResponse.redirect(new URL('/login?error=sso_missing_params', req.url))
    }
    if (state !== stateCookie) {
      return NextResponse.redirect(new URL('/login?error=sso_state_mismatch', req.url))
    }

    const issuer = process.env.OIDC_ISSUER!
    const config = await getOidcConfig(issuer)
    const tokens = await exchangeCode(code, config)

    const { header } = decodeIdToken(tokens.id_token)
    const payload = header.alg === 'RS256'
      ? await verifyIdTokenRs256(tokens.id_token, config, nonceCookie)
      : verifyIdToken(tokens.id_token, config, nonceCookie)

    const userInfo = config.userinfo_endpoint
      ? await fetchUserInfo(tokens.access_token, config)
      : { sub: payload.sub ?? '', email: payload.email, name: payload.name, preferred_username: payload.preferred_username }

    const result = await getOrCreateSsoUser(userInfo)

    await writeAudit({
      userId: result.userId,
      action: result.created ? 'SSO_USER_CREATED' : 'SSO_LOGIN',
      detail: { email: result.email, ssoSubject: userInfo.sub },
    })

    const res = NextResponse.redirect(new URL('/', req.url))
    res.cookies.set('x-active-user', result.sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })
    res.cookies.delete('sso_state')
    res.cookies.delete('sso_nonce')
    return res
  } catch (e) {
    return handleApiError(e, 'SSO callback failed.')
  }
}
