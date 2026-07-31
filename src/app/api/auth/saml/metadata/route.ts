import { NextResponse } from 'next/server'
import { handleApiError } from '@/lib/session'
import { isSamlConfigured, generateSpMetadata } from '@/lib/sso-saml'

/**
 * GET /api/auth/saml/metadata
 *   Returns SP metadata XML. Admins give this URL to their IdP administrator
 *   to configure the Relying Party Trust.
 *
 *   - 200 application/xml when SAML is configured
 *   - 400 when SAML env vars not set
 */
export async function GET() {
  try {
    if (!isSamlConfigured()) {
      return NextResponse.json(
        { error: 'SAML not configured. Set SAML_SP_ENTITY_ID and SAML_SP_CALLBACK_URL.' },
        { status: 400 },
      )
    }

    const xml = generateSpMetadata()
    return new NextResponse(xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml',
        'Cache-Control': 'public, max-age=3600',
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to generate SAML metadata.')
  }
}
