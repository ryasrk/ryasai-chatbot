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
    await getActiveUser()
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const [toolRuns, failedApiRequests, restApiErrors, blockedSql, toolRunCount24h, latencyAgg, failedApiCount24h, llmUsage24h, llmUsageByPurpose] =
      await Promise.all([
        db.toolRun.findMany({ where: {}, orderBy: { createdAt: 'desc' }, take: 50 }),
        db.apiRequestLog.findMany({
          where: { status: { gte: 400 } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        db.restApiRequestLog.findMany({
          where: { errorMessage: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        db.auditLog.findMany({
          where: { action: 'GUARDRAIL_BLOCK' },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        db.toolRun.count({ where: { createdAt: { gte: dayAgo } } }),
        db.toolRun.aggregate({
          where: { createdAt: { gte: dayAgo }, latencyMs: { not: null } },
          _avg: { latencyMs: true },
        }),
        db.apiRequestLog.count({
          where: { status: { gte: 400 }, createdAt: { gte: dayAgo } },
        }),
        db.llmUsageLog.aggregate({
          where: { createdAt: { gte: dayAgo } },
          _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
          _count: true,
        }),
        db.llmUsageLog.groupBy({
          by: ['purpose'],
          where: { createdAt: { gte: dayAgo } },
          _sum: { totalTokens: true },
          _count: true,
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
        llmCalls24h: llmUsage24h._count,
        llmPromptTokens24h: llmUsage24h._sum.promptTokens ?? 0,
        llmCompletionTokens24h: llmUsage24h._sum.completionTokens ?? 0,
        llmTotalTokens24h: llmUsage24h._sum.totalTokens ?? 0,
        llmUsageByPurpose: llmUsageByPurpose.map((r) => ({
          purpose: r.purpose,
          calls: r._count,
          totalTokens: r._sum.totalTokens ?? 0,
        })),
      },
    })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat data monitoring.')
  }
}
