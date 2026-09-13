import { NextRequest, NextResponse } from 'next/server'
import { handleApiError, writeAudit } from '@/lib/session'
import { db } from '@/lib/db'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'
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
    const codeVerifierCookie = req.cookies.get('sso_code_verifier')?.value

    if (!code || !state || !stateCookie) {
      return NextResponse.redirect(new URL('/login?error=sso_missing_params', req.url))
    }
    if (state !== stateCookie) {
      return NextResponse.redirect(new URL('/login?error=sso_state_mismatch', req.url))
    }

    const issuer = process.env.OIDC_ISSUER!
    const config = await getOidcConfig(issuer)
    const tokens = await exchangeCode(code, config, codeVerifierCookie)

    const { header } = decodeIdToken(tokens.id_token)
    const payload = header.alg === 'RS256'
      ? await verifyIdTokenRs256(tokens.id_token, config, nonceCookie)
      : verifyIdToken(tokens.id_token, config, nonceCookie)

    const userInfo = config.userinfo_endpoint
      ? await fetchUserInfo(tokens.access_token, config)
      : { sub: payload.sub ?? '', email: payload.email, name: payload.name, preferred_username: payload.preferred_username }

    const result = await getOrCreateSsoUser(userInfo)

    // THE AUDIT NEEDS AN ORG CONTEXT, AND THIS ROUTE NEVER HAD ONE. `writeAudit` inserts
    // `AuditLog.organizationId` -- a REQUIRED foreign key on an org-scoped model -- from `getOrgContext()`, and
    // `getActiveUser()` is what normally sets that. This is a PUBLIC route with no session yet, so the context was
    // `undefined`, Postgres rejected every insert, and `writeAudit`'s info-severity catch swallowed the failure:
    // the SSO audit trail was SILENTLY EMPTY, including the creation of admin principals. `accept-invite` does this
    // correctly for the same reason; the org is read from the user row that now exists.
    //
    // Read through `bypassOrg` on purpose: the context to enter is exactly what is being looked up, so asking the
    // tenant extension for it would return null and re-create the silent failure.
    const auditUser = await bypassOrg(() =>
      db.user.findFirst({ where: { id: result.userId }, select: { organizationId: true } }),
    )
    if (auditUser?.organizationId) {
      enterWithOrg(auditUser.organizationId)
      // NOT awaited, and that is the fix for the second defect. On the CREATE path the user row already exists by
      // now, and an awaiting audit made the FIRST login fail with a generic 500 -- so the retry took the "existing
      // user" branch and the creation event was permanently mislabelled `SSO_LOGIN`. It also left the state, nonce
      // and PKCE cookies in the browser for their remaining 600s. A failed audit is now logged and the login
      // completes; the login succeeding is the user-visible contract, and the audit failure is not theirs.
      void writeAudit({
        userId: result.userId,
        action: result.created ? 'SSO_USER_CREATED' : 'SSO_LOGIN',
        detail: { email: result.email, ssoSubject: userInfo.sub },
      }).catch((auditError) => {
        console.error('[sso/callback] audit write failed', auditError)
      })
    }

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
    res.cookies.delete('sso_code_verifier')
    return res
  } catch (e) {
    return handleApiError(e, 'SSO callback failed.')
  }
}
