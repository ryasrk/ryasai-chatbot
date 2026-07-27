import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await getActiveUser()
    const { id } = await ctx.params
    const format = req.nextUrl.searchParams.get('format') ?? 'json'

    const schedule = await db.scheduledRun.findFirst({
      where: { id },
      select: { id: true, name: true, cronExpr: true, prompt: true },
    })
    if (!schedule) {
      return NextResponse.json({ ok: false, error: 'Schedule not found.' }, { status: 404 })
    }

    const logs = await db.scheduledRunLog.findMany({
      where: { scheduledRunId: id },
      orderBy: { executedAt: 'asc' },
    })

    if (format === 'csv') {
      const header = 'executedAt,status,latencyMs,answer,error\n'
      const rows = logs.map((l) => {
        const esc = (s: string | null) => `"${(s ?? '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
        return `${l.executedAt.toISOString()},${l.status},${l.latencyMs ?? ''},${esc(l.answer?.slice(0, 500) ?? '')},${esc(l.error ?? '')}`
      })
      const csv = header + rows.join('\n')
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="${schedule.name.replace(/[^a-zA-Z0-9]/g, '_')}_runs.csv"`,
        },
      })
    }

    const json = {
      schedule: {
        id: schedule.id,
        name: schedule.name,
        cronExpr: schedule.cronExpr,
        prompt: schedule.prompt,
      },
      executions: logs.map((l) => ({
        executedAt: l.executedAt.toISOString(),
        status: l.status,
        latencyMs: l.latencyMs,
        answer: l.answer,
        error: l.error,
        toolRuns: l.toolRunsJson ? JSON.parse(l.toolRunsJson) : null,
      })),
    }
    return new NextResponse(JSON.stringify(json, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${schedule.name.replace(/[^a-zA-Z0-9]/g, '_')}_runs.json"`,
      },
    })
  } catch (err) {
    return handleApiError(err, 'Failed to export execution history.')
  }
}
