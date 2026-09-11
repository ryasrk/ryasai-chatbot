/**
 * GET /api/billing/pricing — pack list for the Buy License screen.
 * Auth: session + allowUnlicensed so locked (unpaid) users can see prices.
 */
import { NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { getPacks } from '@/lib/pricing'

export async function GET() {
  try {
    const user = await getActiveUser({ allowUnlicensed: true })
    enterWithOrg(user.organizationId)
    return NextResponse.json({ ok: true, packs: getPacks() })
  } catch (e) {
    return handleApiError(e, 'Failed to load pricing.')
  }
}
