import { NextResponse } from 'next/server'
import { isOidcConfigured } from '@/lib/sso'

export async function GET() {
  return NextResponse.json({ ok: true, configured: isOidcConfigured() })
}
