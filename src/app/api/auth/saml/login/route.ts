import { NextRequest, NextResponse } from 'next/server'
import { handleApiError } from '@/lib/session'
import { isSamlConfigured, generateAuthnRequestRedirectUrl } from '@/lib/sso-saml'

/**
 * GET /api/auth/saml/login
 *   Generates a SAML AuthnRequest and redirects to the IdP's SSO URL.
 *   - 302 redirect to IdP when SAML is configured
 *   - 302 redirect back to /login?error=saml_not_configured when env vars missing
 */
export async function GET(req: NextRequest) {
  try {
    if (!isSamlConfigured()) {
      return NextResponse.redirect(new URL('/login?error=saml_not_configured', req.url))
    }

    const redirectUrl = await generateAuthnRequestRedirectUrl()
    return NextResponse.redirect(redirectUrl, 302)
  } catch (e) {
    return handleApiError(e, 'Failed to initiate SAML login.')
  }
}
