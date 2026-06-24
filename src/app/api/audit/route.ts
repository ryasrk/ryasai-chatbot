import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser } from '@/lib/session'

/**
 * GET /api/audit?severity=info|warning|critical&action=...&page=1&pageSize=20
 * Returns paginated audit logs for the active user's company, sorted desc.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getActiveUser()
    const companyId = user.companyId

    const { searchParams } = req.nextUrl
    const severity = searchParams.get('severity') || undefined
    const action = searchParams.get('action') || undefined
    const page = Math.max(1, Number(searchParams.get('page') ?? '1'))
    const pageSize = Math.max(1, Math.min(100, Number(searchParams.get('pageSize') ?? '20')))

    const where: {
      companyId: string
      severity?: string
      action?: { contains: string }
    } = { companyId }
    if (severity && ['info', 'warning', 'critical'].includes(severity)) {
      where.severity = severity
    }
    if (action) {
      where.action = { contains: action }
    }

    const [items, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, name: true, email: true, role: true } },
        },
      }),
      db.auditLog.count({ where }),
    ])

    return NextResponse.json({ items, total, page, pageSize })
  } catch (err) {
    console.error('[api/audit] error:', err)
    return NextResponse.json(
      { error: 'Gagal memuat audit log.' },
      { status: 500 }
    )
  }
}
