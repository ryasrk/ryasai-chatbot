import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseCron, nextRun, normalizeTimezone } from '@/lib/cron'
import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'
import { hasPlan } from '@/lib/plan-gating'
import { syncSchedule } from '@/lib/scheduler-queue'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET() {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
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
    enterWithOrg(user.organizationId)
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
      integrationId?: string | null
      timezone?: string | null
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

    let integrationId: string | null = null
    if (body.integrationId) {
      const source = await db.integration.findFirst({ where: { id: body.integrationId }, select: { id: true } }) // nosemgrep
      if (!source) {
        return NextResponse.json({ ok: false, error: 'Selected data source not found.' }, { status: 400 })
      }
      integrationId = source.id
    }

    const timezone = normalizeTimezone(body.timezone)
    const nextRunAt = nextRun(cronExpr, new Date(), timezone)
    const schedule = await db.scheduledRun.create({
      data: {
        organizationId: user.organizationId,
        name,
        cronExpr,
        prompt,
        promptId: body.promptId || null,
        timezone,
        isActive: true,
        nextRunAt,
        notificationConfigId: body.notificationConfigId || null,
        integrationId,
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
        integrationId: schedule.integrationId,
        timezone: schedule.timezone,
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
