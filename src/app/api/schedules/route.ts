import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseCron, nextRun, normalizeTimezone, isTimezoneAccepted } from '@/lib/cron'
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
      isActive?: boolean
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

    // `promptId` and `notificationConfigId` used to be written through as `body.x || null`, while `integrationId`
    // just above WAS verified. So a caller could bind a schedule to another organization's saved prompt or
    // notification config simply by sending its id: the cron worker then runs with that prompt's text and delivers
    // to that config's webhook. Both are now resolved through an org-scoped `findFirst`, exactly like integrationId,
    // and a supplied id that does not resolve is refused rather than stored.
    let promptId: string | null = null
    if (body.promptId) {
      const saved = await db.savedPrompt.findFirst({ where: { id: body.promptId }, select: { id: true } })
      if (!saved) {
        return NextResponse.json({ ok: false, error: 'Selected prompt not found.' }, { status: 400 })
      }
      promptId = saved.id
    }

    let notificationConfigId: string | null = null
    if (body.notificationConfigId) {
      const config = await db.notificationConfig.findFirst({
        where: { id: body.notificationConfigId },
        select: { id: true },
      })
      if (!config) {
        return NextResponse.json({ ok: false, error: 'Selected notification config not found.' }, { status: 400 })
      }
      notificationConfigId = config.id
    }

    // A REJECTED zone must not be silently replaced. `normalizeTimezone` falls back to 'UTC', so '09:00 Jakarta'
    // could become '09:00 UTC' -- seven hours off -- while the UI kept showing what was typed. A padded but VALID
    // zone is trimmed and accepted; a zone that is not a zone at all is refused.
    if (body.timezone && !isTimezoneAccepted(body.timezone)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid timezone. Use an IANA zone name such as Asia/Jakarta.' },
        { status: 400 },
      )
    }
    const timezone = normalizeTimezone(body.timezone)
    const nextRunAt = nextRun(cronExpr, new Date(), timezone)
    const schedule = await db.scheduledRun.create({
      data: {
        organizationId: user.organizationId,
        name,
        cronExpr,
        prompt,
        promptId,
        timezone,
        // `isActive` was HARD-CODED `true` while the create form sends the user's toggle: creating a schedule with
        // the toggle OFF still created it ACTIVE and it fired. Only an explicit `false` disables it, so an
        // older client that omits the field keeps the previous behaviour.
        isActive: body.isActive !== false,
        nextRunAt,
        notificationConfigId,
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
