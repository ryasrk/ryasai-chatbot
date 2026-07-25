/**
 * Cognee management API — health, stats, reset, re-cognify, config.
 * GET    /api/cognee         — health + stats
 * POST   /api/cognee         — { action: 'reset' | 'recognify' | 'forget_kb' | 'update_config', ...config }
 */
import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { cogneeStats, resetCognee, cognifyBatch, forgetKnowledgeGraph, invalidateCogneeSettings } from '@/lib/cognee'
import { db } from '@/lib/db'

export async function GET() {
  try {
    const user = await getActiveUser()
    if (!user) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
    const stats = await cogneeStats()

    // Also return config for UI
    const config = await db.appConfig.findFirst()
    const cogneeConfig = config ? {
      enabled: config.cogneeEnabled,
      dbProvider: config.cogneeDbProvider ?? 'local',
      dbUrl: config.cogneeDbUrl ?? '',
      batchSize: config.cogneeBatchSize,
      maxRetries: config.cogneeMaxRetries,
    } : null

    return NextResponse.json({ ok: true, data: { ...stats, config: cogneeConfig } })
  } catch (e) {
    return handleApiError(e, 'Failed to get cognee stats.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    if (!user) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json().catch(() => ({}))
    const action = body.action as string

    if (action === 'update_config') {
      const { enabled, dbProvider, dbUrl, batchSize, maxRetries } = body
      const existing = await db.appConfig.findFirst()
      if (existing) {
        await db.appConfig.update({
          where: { id: existing.id },
          data: {
            cogneeEnabled: Boolean(enabled),
            cogneeDbProvider: dbProvider === 'postgres' ? 'postgres' : 'local',
            cogneeDbUrl: dbUrl || null,
            cogneeBatchSize: Math.max(1, Math.min(500, parseInt(batchSize) || 50)),
            cogneeMaxRetries: Math.max(0, Math.min(10, parseInt(maxRetries) || 3)),
          },
        })
      } else {
        await db.appConfig.create({
          data: {
            cogneeEnabled: Boolean(enabled),
            cogneeDbProvider: dbProvider === 'postgres' ? 'postgres' : 'local',
            cogneeDbUrl: dbUrl || null,
            cogneeBatchSize: Math.max(1, Math.min(500, parseInt(batchSize) || 50)),
            cogneeMaxRetries: Math.max(0, Math.min(10, parseInt(maxRetries) || 3)),
          },
        })
      }
      invalidateCogneeSettings()
      return NextResponse.json({ ok: true, data: { updated: true } })
    }

    if (action === 'reset') {
      const ok = await resetCognee()
      return NextResponse.json({ ok, data: { reset: ok } })
    }

    if (action === 'forget_kb') {
      const ok = await forgetKnowledgeGraph()
      return NextResponse.json({ ok, data: { forgotten: ok } })
    }

    if (action === 'recognify') {
      const docs = await db.document.findMany({
        where: {
          status: 'ready',
          isEnabled: true,
          OR: [
            { cognifyStatus: null },
            { cognifyStatus: { not: 'completed' } },
          ],
        },
        include: {
          chunks: { select: { content: true, chunkIndex: true }, orderBy: { chunkIndex: 'asc' } },
        },
      })

      if (docs.length === 0) {
        return NextResponse.json({ ok: true, data: { processed: 0, failed: 0, skipped: 0, message: 'All documents already cognified' } })
      }

      const result = await cognifyBatch({
        documents: docs.map((doc) => ({
          documentId: doc.id,
          documentName: doc.name,
          chunks: doc.chunks.map((c) => ({ content: c.content, chunkIndex: c.chunkIndex })),
        })),
      })

      return NextResponse.json({ ok: true, data: result })
    }

    return NextResponse.json(
      { ok: false, error: 'Unknown action. Use: reset, forget_kb, recognify, update_config' },
      { status: 400 },
    )
  } catch (e) {
    return handleApiError(e, 'Cognee action failed.')
  }
}
