import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, type ActiveUser } from '@/lib/session'

/**
 * GET /api/me
 *   Returns the active user { userId, companyId, role, name, email } plus
 *   the company name.
 *
 * POST /api/me
 *   Body: { userId }
 *   Switches the active user (demo only — lets the UI pretend to be
 *   admin/manager/staff). Sets the `x-active-user` cookie (maxAge 7 days,
 *   httpOnly false so client can read) and returns the new active user.
 */
export async function GET() {
  try {
    const user = await getActiveUser()
    const company = await db.company.findUnique({
      where: { id: user.companyId },
      select: { name: true },
    })

    return NextResponse.json({ ...user, companyName: company?.name ?? null })
  } catch (err) {
    console.error('[api/me GET] error:', err)
    return NextResponse.json(
      { error: 'Gagal memuat data pengguna aktif.' },
      { status: 500 }
    )
  }
}

export async function POST(req: NextRequest) {
  try {
    const current = await getActiveUser()
    const body = await req.json().catch(() => ({}))
    const targetUserId = typeof body?.userId === 'string' ? body.userId : null
    if (!targetUserId) {
      return NextResponse.json(
        { error: 'userId wajib diisi.' },
        { status: 400 }
      )
    }

    // Only allow switching within the same company so multi-tenant boundary
    // is preserved.
    const target = await db.user.findFirst({
      where: { id: targetUserId, companyId: current.companyId, isActive: true },
      select: { id: true, companyId: true, role: true, name: true, email: true },
    })
    if (!target) {
      return NextResponse.json(
        { error: 'Pengguna tidak ditemukan pada perusahaan ini.' },
        { status: 404 }
      )
    }

    const next: ActiveUser = {
      userId: target.id,
      companyId: target.companyId,
      role: target.role as ActiveUser['role'],
      name: target.name,
      email: target.email,
    }

    await writeAudit({
      companyId: next.companyId,
      userId: next.userId,
      action: 'USER_SWITCH',
      severity: 'warning',
      detail: {
        fromUserId: current.userId,
        fromName: current.name,
        toUserId: next.userId,
        toName: next.name,
        toRole: next.role,
      },
    })

    const company = await db.company.findUnique({
      where: { id: next.companyId },
      select: { name: true },
    })

    // In Next.js 16 route handlers, cookies().set() does NOT persist to the
    // HTTP response — we must set the cookie on the NextResponse itself.
    const res = NextResponse.json({ ...next, companyName: company?.name ?? null })
    res.cookies.set('x-active-user', JSON.stringify(next), {
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
      httpOnly: false, // client can read
      sameSite: 'lax',
    })
    return res
  } catch (err) {
    console.error('[api/me POST] error:', err)
    return NextResponse.json(
      { error: 'Gagal mengganti pengguna aktif.' },
      { status: 500 }
    )
  }
}
