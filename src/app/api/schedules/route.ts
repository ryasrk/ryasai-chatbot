import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseCron, nextRun } from '@/lib/cron'
import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'
import { hasPlan } from '@/lib/plan-gating'
import { syncSchedule } from '@/lib/scheduler-queue'

export async function GET() {
  try {
    await getActiveUser()
    const schedules = await db.scheduledRun.findMany({
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ ok: true, schedules })
  } catch (e) {
    return handleApiError(e, 'Failed to load scheduled runs.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    requireRole(user, 'admin')
    if (!hasPlan(user.plan, 'pro')) {
      return NextResponse.json({ error: 'Scheduled runs require a Pro plan or higher.' }, { status: 403 })
    }

    const body = (await req.json().catch(() => ({}))) as {
      name?: string
      cronExpr?: string
      prompt?: string
      promptId?: string | null
      notificationConfigId?: string | null
    }

    const name = (body.name ?? '').trim()
    if (!name) {
      return NextResponse.json({ ok: false, error: 'Name is required.' }, { status: 400 })
    }
    const cronExpr = (body.cronExpr ?? '').trim()
    if (!parseCron(cronExpr)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid cron expression. Use 5-field format: min hour dom month dow.' },
        { status: 400 },
      )
    }
    const prompt = (body.prompt ?? '').trim()
    if (!prompt) {
      return NextResponse.json({ ok: false, error: 'Prompt is required.' }, { status: 400 })
    }

    const nextRunAt = nextRun(cronExpr, new Date())
    const schedule = await db.scheduledRun.create({
      data: {
        organizationId: user.organizationId,
        name,
        cronExpr,
        prompt,
        promptId: body.promptId || null,
        isActive: true,
        nextRunAt,
        notificationConfigId: body.notificationConfigId || null,
      },
    })

    // Sync to BullMQ
    try {
      await syncSchedule({
        id: schedule.id,
        name: schedule.name,
        cronExpr: schedule.cronExpr,
        prompt: schedule.prompt,
        isActive: schedule.isActive,
        notificationConfigId: schedule.notificationConfigId,
      })
    } catch (e) {
      console.error('[schedules] BullMQ sync failed (non-fatal):', e)
    }

    await writeAudit({
      userId: user.userId,
      action: 'SCHEDULE_CREATE',
      severity: 'info',
      detail: { id: schedule.id, name, cronExpr, nextRunAt: nextRunAt?.toISOString() ?? null },
    })

    return NextResponse.json({ ok: true, schedule }, { status: 201 })
  } catch (e) {
    return handleApiError(e, 'Failed to create scheduled run.')
  }
}
