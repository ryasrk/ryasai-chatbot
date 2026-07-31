import { NextResponse } from 'next/server'
import { isOidcConfigured } from '@/lib/sso'
import { isSamlConfigured } from '@/lib/sso-saml'

export async function GET() {
  const oidc = isOidcConfigured()
  const saml = isSamlConfigured()
  return NextResponse.json({
    ok: true,
    oidc,
    saml,
    configured: oidc || saml,
  })
}
