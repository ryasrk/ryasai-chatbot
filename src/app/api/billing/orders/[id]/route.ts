/**
 * GET /api/billing/orders/[id] — status polling for the checkout flow.
 * Auth: session + allowUnlicensed. Tenant scoping via the Prisma extension
 * restricts findFirst to the caller's own org.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getActiveUser({ allowUnlicensed: true })
    enterWithOrg(user.organizationId)

    const { id } = await ctx.params
    const order = await db.order.findFirst({
      where: { id },
      select: { status: true, months: true, amountIdr: true, licenseKeyIssued: true },
    })
    if (!order) {
      return NextResponse.json({ ok: false, error: 'Order not found.' }, { status: 404 })
    }

    return NextResponse.json({
      ok: true,
      order: {
        status: order.status,
        months: order.months,
        amountIdr: order.amountIdr,
        licenseIssued: Boolean(order.licenseKeyIssued),
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load billing order.')
  }
}
