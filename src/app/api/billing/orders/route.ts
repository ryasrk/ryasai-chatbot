/**
 * POST /api/billing/orders — create a QRIS (Midtrans Snap) order.
 * Auth: session + getActiveUser({ allowUnlicensed: true }) so unpaid orgs can
 * reach checkout. Amount ALWAYS comes from the pricing table, never the client.
 */
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { findPack } from '@/lib/pricing'
import { createSnapTransaction } from '@/lib/midtrans'

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser({ allowUnlicensed: true })
    enterWithOrg(user.organizationId)

    const body = (await req.json().catch(() => ({}))) as { months?: unknown }
    const months = Number(body.months)
    const pack = findPack(months)
    if (!pack) {
      return NextResponse.json(
        { ok: false, error: 'Invalid pack. Choose one of the available month options.' },
        { status: 400 },
      )
    }

    const org = await db.organization.findUnique({
      where: { id: user.organizationId },
      select: { slug: true },
    })
    if (!org) {
      return NextResponse.json({ ok: false, error: 'Organization not found.' }, { status: 404 })
    }

    // Midtrans order_id max 50 chars — cap the slug portion.
    const midtransOrderId = `ord-${org.slug.slice(0, 20)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
    const snap = await createSnapTransaction({
      orderId: midtransOrderId,
      grossAmount: pack.amountIdr,
      itemName: `ryasai subscription ${pack.months} month${pack.months > 1 ? 's' : ''}`,
    })

    const order = await db.order.create({
      data: {
        organizationId: user.organizationId,
        months: pack.months,
        amountIdr: pack.amountIdr,
        currency: 'IDR',
        midtransOrderId,
        snapToken: snap.token,
        status: 'pending',
      },
    })

    return NextResponse.json(
      { ok: true, orderId: order.id, token: snap.token, redirectUrl: snap.redirectUrl },
      { status: 201 },
    )
  } catch (e) {
    return handleApiError(e, 'Failed to create billing order.')
  }
}
