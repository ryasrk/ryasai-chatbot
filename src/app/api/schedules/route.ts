import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseCron, nextRun } from '@/lib/cron'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

export async function GET() {
  try {
    await getActiveUser()
    const schedules = await db.scheduledRun.findMany({
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ ok: true, schedules })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat scheduled runs.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()

    const body = (await req.json().catch(() => ({}))) as {
      name?: string
      cronExpr?: string
      prompt?: string
    }

    const name = (body.name ?? '').trim()
    if (!name) {
      return NextResponse.json({ ok: false, error: 'Nama wajib diisi.' }, { status: 400 })
    }
    const cronExpr = (body.cronExpr ?? '').trim()
    if (!parseCron(cronExpr)) {
      return NextResponse.json(
        { ok: false, error: 'Cron expression tidak valid. Gunakan format 5-field: min hour dom month dow.' },
        { status: 400 },
      )
    }
    const prompt = (body.prompt ?? '').trim()
    if (!prompt) {
      return NextResponse.json({ ok: false, error: 'Prompt wajib diisi.' }, { status: 400 })
    }

    const nextRunAt = nextRun(cronExpr, new Date())
    const schedule = await db.scheduledRun.create({
      data: {
        name,
        cronExpr,
        prompt,
        isActive: true,
        nextRunAt,
      },
    })

    await writeAudit({
      userId: user.userId,
      action: 'SCHEDULE_CREATE',
      severity: 'info',
      detail: { id: schedule.id, name, cronExpr, nextRunAt: nextRunAt?.toISOString() ?? null },
    })

    return NextResponse.json({ ok: true, schedule }, { status: 201 })
  } catch (e) {
    return handleApiError(e, 'Gagal membuat scheduled run.')
  }
}
