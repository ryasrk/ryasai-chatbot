import { NextResponse } from 'next/server'
import { rebuildFts } from '@/lib/rag-fts'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { jobQueue, checkRedisHealth } from '@/lib/redis'

export const runtime = 'nodejs'

export async function POST() {
  try {
    const user = await getActiveUser()

    // ponytail: enqueue to Redis when available, run synchronously when Redis is down.
    const health = await checkRedisHealth()
    if (health.connected) {
      await jobQueue.add('fts-rebuild', { type: 'fts-rebuild' })
      await writeAudit({
        userId: user.userId,
        action: 'RAG_FTS_REBUILD',
        severity: 'info',
        detail: { queued: true },
      })
      return NextResponse.json({ ok: true, message: 'FTS rebuild queued', data: { indexed: 0 } })
    }

    // sync fallback — Redis down
    const result = await rebuildFts()
    await writeAudit({
      userId: user.userId,
      action: 'RAG_FTS_REBUILD',
      severity: 'info',
      detail: result,
    })
    return NextResponse.json({ ok: true, message: 'FTS rebuild completed', data: result })
  } catch (e) {
    return handleApiError(e, 'Failed to rebuild FTS.', 500)
  }
}
