import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

const DEFAULT_AUDIT_PAGE_SIZE = 20
const MAX_AUDIT_PAGE_SIZE = 20

export function parseAuditPagination(searchParams: URLSearchParams) {
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
  const requestedPageSize =
    parseInt(searchParams.get('pageSize') ?? String(DEFAULT_AUDIT_PAGE_SIZE), 10) ||
    DEFAULT_AUDIT_PAGE_SIZE
  const pageSize = Math.max(1, Math.min(MAX_AUDIT_PAGE_SIZE, requestedPageSize))

  return { page, pageSize }
}

/**
 * GET /api/audit?severity=info|warning|critical&action=...&page=1&pageSize=20
 * Returns paginated audit logs for the active user's company, sorted desc.
 */
export async function GET(req: NextRequest) {
  try {
    await getActiveUser()

    const { searchParams } = req.nextUrl
    const severity = searchParams.get('severity') || undefined
    const action = searchParams.get('action') || undefined
    const { page, pageSize } = parseAuditPagination(searchParams)

    const where: {
      severity?: string
      action?: { contains: string }
    } = {}
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
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      db.auditLog.count({ where }),
    ])

    return NextResponse.json({ items, total, page, pageSize })
  } catch (err) {
    return handleApiError(err, 'Failed to load audit log.')
  }
}
