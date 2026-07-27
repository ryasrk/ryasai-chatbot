import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await getActiveUser()
    const { id } = await ctx.params

    const runs = await db.scheduledRunLog.findMany({
      where: { scheduledRunId: id },
      orderBy: { executedAt: 'desc' },
      take: 50,
    })

    return NextResponse.json({
      ok: true,
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        answer: r.answer,
        error: r.error,
        toolRuns: r.toolRunsJson ? JSON.parse(r.toolRunsJson) : null,
        latencyMs: r.latencyMs,
        executedAt: r.executedAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleApiError(err, 'Failed to load execution history.')
  }
}
