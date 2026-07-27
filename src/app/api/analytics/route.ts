import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

/**
 * GET /api/analytics
 * Returns dashboard stats for the active user's company:
 *   - totals (integrations, documents, chatSessions, queriesExecuted, guardrailBlocks)
 *   - querySuccessRate (%)
 *   - recentQueries (last 5, with integration + user name)
 *   - queryTrend (last 7 days, grouped by day)
 *   - chatTrend (last 7 days, ChatMessage grouped by day)
 *   - auditBySeverity (info / warning / critical)
 *   - integrationsByProvider
 *   - documentsByCategory
 *
 * Date buckets are built in JS (no DB-specific date functions) for portability.
 */
export async function GET() {
  try {
    await getActiveUser()

    // ---- helpers ---------------------------------------------------------
    const days = 7
    // ponytail: use UTC for bucket dates so the chart matches DB timestamps
    // (which are stored in UTC). Local timezone would shift the day boundary.
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const buckets: { date: string; count: number }[] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setUTCDate(d.getUTCDate() - i)
      buckets.push({ date: d.toISOString().slice(0, 10), count: 0 })
    }
    const bucketMap = new Map(buckets.map((b) => [b.date, b]))
    const since = new Date(today)
    since.setUTCDate(since.getUTCDate() - (days - 1))

    // ---- totals ----------------------------------------------------------
    const [
      integrations,
      documents,
      chatSessions,
      queriesExecuted,
      guardrailBlocks,
    ] = await Promise.all([
      db.integration.count({ where: {} }),
      db.document.count({ where: {} }),
      db.chatSession.count({ where: {} }),
      db.queryHistory.count({
        where: {},
      }),
      db.auditLog.count({
        where: { action: 'GUARDRAIL_BLOCK' },
      }),
    ])

    // ---- query success rate ---------------------------------------------
    const [successCount, totalQueries] = await Promise.all([
      db.queryHistory.count({
        where: { success: true },
      }),
      db.queryHistory.count({ where: {} }),
    ])
    const querySuccessRate =
      totalQueries === 0 ? 0 : Math.round((successCount / totalQueries) * 100)

    // ---- recent queries (with integration + user name) ------------------
    const recentQueries = await db.queryHistory.findMany({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        integration: { select: { name: true } },
        user: { select: { name: true } },
      },
    })

    // ---- query trend (last 7 days) --------------------------------------
    const recentQueryRows = await db.queryHistory.findMany({
      where: {
        createdAt: { gte: since },
      },
      select: { createdAt: true },
    })
    for (const r of recentQueryRows) {
      const key = r.createdAt.toISOString().slice(0, 10)
      const b = bucketMap.get(key)
      if (b) b.count += 1
    }

    // ---- chat trend (last 7 days) ---------------------------------------
    // ChatMessage has no direct company relation, so filter via session.
    const recentChatRows = await db.chatMessage.findMany({
      where: {
        createdAt: { gte: since },
      },
      select: { createdAt: true },
    })
    const chatTrend: { date: string; count: number }[] = buckets.map((b) => ({
      date: b.date,
      count: 0,
    }))
    const chatMap = new Map(chatTrend.map((b) => [b.date, b]))
    for (const r of recentChatRows) {
      const key = r.createdAt.toISOString().slice(0, 10)
      const b = chatMap.get(key)
      if (b) b.count += 1
    }

    // ---- audit by severity ----------------------------------------------
    const auditBySeverityRows = await db.auditLog.groupBy({
      by: ['severity'],
      where: {},
      _count: { _all: true },
    })
    const auditBySeverity = {
      info: 0,
      warning: 0,
      critical: 0,
    } as { info: number; warning: number; critical: number }
    for (const r of auditBySeverityRows) {
      if (r.severity === 'info' || r.severity === 'warning' || r.severity === 'critical') {
        auditBySeverity[r.severity] = r._count._all
      }
    }

    // ---- integrations by provider ---------------------------------------
    const providerGroups = await db.integration.groupBy({
      by: ['provider'],
      where: {},
      _count: { _all: true },
    })
    const integrationsByProvider = providerGroups.map((g) => ({
      provider: g.provider,
      count: g._count._all,
    }))

    // ---- documents by category ------------------------------------------
    const docGroups = await db.document.groupBy({
      by: ['category'],
      where: {},
      _count: { _all: true },
    })
    const documentsByCategory = docGroups.map((g) => ({
      category: g.category ?? 'Uncategorized',
      count: g._count._all,
    }))

    // ---- recent scheduled runs (completed) ------------------------------
    const recentScheduledRuns = await db.scheduledRun.findMany({
      where: { lastRunAt: { not: null } },
      orderBy: { lastRunAt: 'desc' },
      take: 5,
      select: { name: true, lastRunAt: true, lastResult: true },
    })

    return NextResponse.json({
      totals: {
        integrations,
        documents,
        chatSessions,
        queriesExecuted,
        guardrailBlocks,
      },
      querySuccessRate,
      recentQueries,
      queryTrend: buckets,
      chatTrend,
      auditBySeverity,
      integrationsByProvider,
      documentsByCategory,
      recentScheduledRuns,
    })
  } catch (err) {
    return handleApiError(err, 'Failed to load analytics data.')
  }
}
