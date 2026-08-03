import { NextRequest, NextResponse } from 'next/server'
import { db, isPrismaNotFound } from '@/lib/db'
import { parseCron, nextRun, normalizeTimezone } from '@/lib/cron'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { syncSchedule, removeSchedule } from '@/lib/scheduler-queue'
import { enterWithOrg } from '@/lib/prisma-tenant'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { id } = await ctx.params
    const schedule = await db.scheduledRun.findFirst({ // nosemgrep
      where: { id },
    })
    if (!schedule) {
      return NextResponse.json(
        { ok: false, error: 'Scheduled run not found.' },
        { status: 404 },
      )
    }
    return NextResponse.json({ ok: true, schedule })
  } catch (e) {
    return handleApiError(e, 'Failed to load scheduled run.')
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)

    const { id } = await ctx.params
    const existing = await db.scheduledRun.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, cronExpr: true, isActive: true, name: true, timezone: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'Scheduled run not found.' },
        { status: 404 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as {
      name?: string
      cronExpr?: string
      prompt?: string
      isActive?: boolean
      notificationConfigId?: string | null
      timezone?: string | null
    }

    const data: {
      name?: string
      cronExpr?: string
      prompt?: string
      isActive?: boolean
      nextRunAt?: Date | null
      notificationConfigId?: string | null
      timezone?: string
    } = {}

    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
    if (typeof body.prompt === 'string' && body.prompt.trim()) data.prompt = body.prompt.trim()
    if (body.notificationConfigId !== undefined) data.notificationConfigId = body.notificationConfigId || null
    if (body.timezone !== undefined) data.timezone = normalizeTimezone(body.timezone)

    const changingCron = typeof body.cronExpr === 'string'
    if (changingCron) {
      const cronExpr = body.cronExpr!.trim()
      if (!parseCron(cronExpr)) {
        return NextResponse.json(
          { ok: false, error: 'Invalid cron expression.' },
          { status: 400 },
        )
      }
      data.cronExpr = cronExpr
    }

    const becomingActive = body.isActive === true && !existing.isActive
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive

    // Recompute nextRunAt when the schedule becomes due again.
    if (body.isActive === false) {
      data.nextRunAt = null
    } else if (changingCron || becomingActive) {
      const cronExpr = typeof data.cronExpr === 'string' ? data.cronExpr : existing.cronExpr
      data.nextRunAt = nextRun(cronExpr, new Date())
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No fields provided for update.' },
        { status: 400 },
      )
    }

    const updated = await db.scheduledRun.update({
      where: { id: existing.id },
      data,
    }).catch((e: unknown) => {
      if (isPrismaNotFound(e)) return null
      throw e
    })
    if (!updated) {
      return NextResponse.json(
        { ok: false, error: 'Scheduled run not found.' },
        { status: 404 },
      )
    }

    // Sync to BullMQ
    try {
      if (updated.isActive) {
        await syncSchedule({
          id: updated.id,
          name: updated.name,
          cronExpr: updated.cronExpr,
          prompt: updated.prompt,
          isActive: updated.isActive,
          notificationConfigId: updated.notificationConfigId,
          timezone: updated.timezone,
        })
      } else {
        await removeSchedule(updated.id, existing.cronExpr, existing.timezone)
      }
    } catch (e) {
      console.error('[schedules] BullMQ sync failed (non-fatal):', e)
    }

    await writeAudit({
      userId: user.userId,
      action: 'SCHEDULE_UPDATE',
      severity: 'info',
      detail: { id: updated.id, name: updated.name, changes: data },
    })

    return NextResponse.json({ ok: true, schedule: updated })
  } catch (e) {
    return handleApiError(e, 'Failed to update scheduled run.')
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)

    const { id } = await ctx.params
    const existing = await db.scheduledRun.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, name: true },
    })
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: 'Scheduled run not found.' },
        { status: 404 },
      )
    }

    const result = await db.scheduledRun.deleteMany({ where: { id } })
    if (result.count === 0) {
      return NextResponse.json(
        { ok: false, error: 'Scheduled run not found.' },
        { status: 404 },
      )
    }

    // Remove from BullMQ
    try {
      await removeSchedule(existing.id)
    } catch (e) {
      console.error('[schedules] BullMQ removal failed (non-fatal):', e)
    }

    await writeAudit({
      userId: user.userId,
      action: 'SCHEDULE_DELETE',
      severity: 'warning',
      detail: { id: existing.id, name: existing.name },
    })

    return NextResponse.json({ ok: true, deleted: true })
  } catch (e) {
    return handleApiError(e, 'Failed to delete scheduled run.')
  }
}
