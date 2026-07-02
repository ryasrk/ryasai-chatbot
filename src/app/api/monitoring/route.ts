import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

/**
 * GET /api/monitoring → aggregated observability data:
 *   - toolRuns: last 50 tool executions
 *   - failedApiRequests: last 50 API requests with status >= 400
 *   - restApiErrors: last 50 REST requests with errorMessage
 *   - blockedSql: last 50 GUARDRAIL_BLOCK audits
 *   - stats: 24h counts + average latency
 */
export async function GET() {
  try {
    const user = await getActiveUser()
    const companyId = user.companyId
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const [toolRuns, failedApiRequests, restApiErrors, blockedSql, toolRunCount24h, latencyAgg, failedApiCount24h] =
      await Promise.all([
        db.toolRun.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 50 }),
        db.apiRequestLog.findMany({
          where: { companyId, status: { gte: 400 } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        db.restApiRequestLog.findMany({
          where: { companyId, errorMessage: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        db.auditLog.findMany({
          where: { companyId, action: 'GUARDRAIL_BLOCK' },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        db.toolRun.count({ where: { companyId, createdAt: { gte: dayAgo } } }),
        db.toolRun.aggregate({
          where: { companyId, createdAt: { gte: dayAgo }, latencyMs: { not: null } },
          _avg: { latencyMs: true },
        }),
        db.apiRequestLog.count({
          where: { companyId, status: { gte: 400 }, createdAt: { gte: dayAgo } },
        }),
      ])

    return NextResponse.json({
      ok: true,
      toolRuns,
      failedApiRequests,
      restApiErrors,
      blockedSql,
      stats: {
        toolRunCount24h,
        avgToolLatencyMs24h: Math.round(latencyAgg._avg.latencyMs ?? 0),
        failedApiCount24h,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat data monitoring.')
  }
}
