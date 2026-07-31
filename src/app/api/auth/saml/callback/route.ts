import { NextRequest, NextResponse } from 'next/server'
import { handleApiError, writeAudit } from '@/lib/session'
import { isSamlConfigured, validateSamlResponse, getOrCreateSsoUser } from '@/lib/sso-saml'

/**
 * POST /api/auth/saml/callback
 *   IdP POSTs SAMLResponse here after user authenticates.
 *   Validates the response, extracts user info, sets session cookie.
 *   Supports both SP-initiated and IdP-initiated login (unsolicited responses).
 *
 * Body: SAMLResponse=base64-encoded-xml (form-encoded)
 */
export async function POST(req: NextRequest) {
  try {
    if (!isSamlConfigured()) {
      return NextResponse.json({ error: 'SAML not configured.' }, { status: 400 })
    }

    const formData = await req.formData()
    const samlResponse = formData.get('SAMLResponse')
    if (!samlResponse || typeof samlResponse !== 'string') {
      return NextResponse.redirect(new URL('/login?error=saml_missing_response', req.url))
    }

    const userInfo = await validateSamlResponse(samlResponse)
    const result = await getOrCreateSsoUser(userInfo)

    await writeAudit({
      userId: result.userId,
      action: result.created ? 'SAML_USER_CREATED' : 'SAML_LOGIN',
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
    return res
  } catch (e) {
    return handleApiError(e, 'SAML callback failed.')
  }
}

/**
 * GET /api/auth/saml/callback
 *   If someone navigates here directly without a POST, redirect to login.
 */
export async function GET() {
  return NextResponse.redirect(new URL('/login?error=saml_no_post', '/'))
}
