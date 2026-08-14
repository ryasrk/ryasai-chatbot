import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { scheduleQueue } from '@/lib/scheduler-queue'
import { enterWithOrg } from '@/lib/prisma-tenant'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * POST /api/schedules/[id]/run
 *   Manually trigger a schedule immediately (one-off, does not affect the cron schedule).
 *   Adds a single job to BullMQ with the same data as the repeatable job.
 */
export async function POST(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    const { id } = await ctx.params

    const schedule = await db.scheduledRun.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true, prompt: true, notificationConfigId: true, integrationId: true },
    })
    if (!schedule) {
      return NextResponse.json(
        { ok: false, error: 'Scheduled run not found.' },
        { status: 404 },
      )
    }

    // Add one-off job to BullMQ (not repeatable — runs once immediately)
    await scheduleQueue.add(
      `manual-run:${schedule.id}`,
      {
        runId: schedule.id,
        name: schedule.name,
        prompt: schedule.prompt,
        notificationConfigId: schedule.notificationConfigId,
        integrationId: schedule.integrationId,
      },
      { jobId: `manual-${schedule.id}-${Date.now()}` },
    )

    await writeAudit({
      userId: user.userId,
      action: 'SCHEDULE_MANUAL_RUN',
      severity: 'info',
      detail: { id: schedule.id, name: schedule.name },
    })

    return NextResponse.json({ ok: true, message: 'Schedule triggered manually.' })
  } catch (e) {
    return handleApiError(e, 'Failed to trigger schedule.')
  }
}
