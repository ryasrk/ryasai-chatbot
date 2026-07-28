import { NextRequest, NextResponse } from 'next/server'
import { db, isPrismaNotFound } from '@/lib/db'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()

    const { id } = await ctx.params
    const existing = await db.apiKey.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, label: true, keyPrefix: true, revokedAt: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'API key not found.' },
        { status: 404 },
      )
    }

    const item = await db.apiKey.update({
      where: { id: existing.id },
      data: {
        isActive: false,
        revokedAt: existing.revokedAt ?? new Date(),
      },
      select: {
        id: true,
        label: true,
        keyPrefix: true,
        isActive: true,
        revokedAt: true,
      },
    }).catch((e: unknown) => {
      if (isPrismaNotFound(e)) return null
      throw e
    })
    if (!item) {
      return NextResponse.json(
        { ok: false, error: 'API key not found.' },
        { status: 404 },
      )
    }

    await writeAudit({
      userId: user.userId,
      action: 'API_KEY_REVOKE',
      severity: 'warning',
      detail: { apiKeyId: item.id, label: item.label, keyPrefix: item.keyPrefix },
    })

    return NextResponse.json({ ok: true, item })
  } catch (e) {
    return handleApiError(e, 'Failed to revoke API key.')
  }
}
