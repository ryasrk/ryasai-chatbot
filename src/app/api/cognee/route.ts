import { enterWithOrg } from '@/lib/prisma-tenant'
/**
 * Cognee management API — health, stats, reset, re-cognify, config.
 * GET    /api/cognee         — health + stats
 * POST   /api/cognee         — { action: 'reset' | 'recognify' | 'forget_kb' | 'update_config', ...config }
 */
import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { cogneeStats, resetCognee, cognifyBatch, forgetKnowledgeGraph, invalidateCogneeSettings, autoCognifyAll } from '@/lib/cognee'
import { db } from '@/lib/db'

/**
 * Cognee's relational store URL. Admin-supplied, but it is a credential-bearing
 * connection string that the server dials out to, so it has to parse as postgres
 * — not just be truthy. Empty string clears it.
 */
function parseCogneeDbUrl(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, error: 'dbUrl must be a string.' }
  const trimmed = raw.trim()
  if (!trimmed) return { ok: true, value: null }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: 'dbUrl is not a valid URL.' }
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return { ok: false, error: 'dbUrl must use the postgres:// or postgresql:// scheme.' }
  }
  if (!parsed.hostname) return { ok: false, error: 'dbUrl is missing a host.' }
  return { ok: true, value: trimmed }
}

export async function GET() {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
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
    enterWithOrg(user.organizationId)
    // Every action below is destructive (reset/forget wipe the graph), spends LLM
    // budget (recognify), or rewrites where org data is stored (update_config's
    // dbUrl). None of it belongs to a viewer or analyst.
    requireRole(user, 'admin')

    const body = await req.json().catch(() => ({}))
    const action = body.action as string

    if (action === 'update_config') {
      const { enabled, dbProvider, dbUrl, batchSize, maxRetries } = body
      const willBeEnabled = Boolean(enabled)
      const willBeDbProvider = dbProvider === 'postgres' ? 'postgres' : 'local'
      const parsedUrl = parseCogneeDbUrl(dbUrl)
      if (!parsedUrl.ok) {
        return NextResponse.json({ ok: false, error: parsedUrl.error }, { status: 400 })
      }
      const willBeDbUrl = parsedUrl.value
      if (willBeDbProvider === 'postgres' && !willBeDbUrl) {
        return NextResponse.json(
          { ok: false, error: 'dbUrl is required when dbProvider is postgres.' },
          { status: 400 },
        )
      }
      const existing = await db.appConfig.findFirst()
      const wasEnabled = existing?.cogneeEnabled ?? false
      const wasDbProvider = existing?.cogneeDbProvider ?? 'local'
      const wasDbUrl = existing?.cogneeDbUrl ?? null

      // Purge BEFORE persisting the disable. forgetKnowledgeGraph() short-circuits
      // on isCogneeEnabled(), so the old "write disabled config, then fire-and-forget
      // the purge" order meant the graph was never actually deleted — it just
      // stopped being read, and came back intact on re-enable.
      let purged: boolean | null = null
      if (wasEnabled && !willBeEnabled) {
        purged = await forgetKnowledgeGraph().catch(() => false)
      }

      if (existing) {
        await db.appConfig.update({
          where: { id: existing.id },
          data: {
            cogneeEnabled: willBeEnabled,
            cogneeDbProvider: willBeDbProvider,
            cogneeDbUrl: willBeDbUrl,
            cogneeBatchSize: Math.max(1, Math.min(500, parseInt(batchSize) || 50)),
            cogneeMaxRetries: Math.max(0, Math.min(10, parseInt(maxRetries) || 3)),
          },
        })
      } else {
        await db.appConfig.create({
          data: {
            organizationId: user.organizationId,
            cogneeEnabled: willBeEnabled,
            cogneeDbProvider: willBeDbProvider,
            cogneeDbUrl: willBeDbUrl,
            cogneeBatchSize: Math.max(1, Math.min(500, parseInt(batchSize) || 50)),
            cogneeMaxRetries: Math.max(0, Math.min(10, parseInt(maxRetries) || 3)),
          },
        })
      }
      invalidateCogneeSettings()

      const storeChanged = wasEnabled && willBeEnabled &&
        (wasDbProvider !== willBeDbProvider || wasDbUrl !== willBeDbUrl)
      if (wasEnabled && !willBeEnabled) {
        // Already purged above, while cognee was still enabled.
      } else if (!wasEnabled && willBeEnabled) {
        // Cognee newly enabled — auto-cognify all ready documents
        void autoCognifyAll().catch(() => null)
      } else if (storeChanged) {
        // Store changed while enabled — forget stale data, re-cognify
        void forgetKnowledgeGraph().catch(() => null)
        void autoCognifyAll().catch(() => null)
      }

      await writeAudit({
        userId: user.userId,
        action: 'COGNEE_CONFIG_UPDATE',
        severity: 'warning',
        detail: {
          before: { enabled: wasEnabled, dbProvider: wasDbProvider, dbUrlSet: !!wasDbUrl },
          after: { enabled: willBeEnabled, dbProvider: willBeDbProvider, dbUrlSet: !!willBeDbUrl },
          purged,
        },
      })

      return NextResponse.json({ ok: true, data: { updated: true, purged } })
    }

    if (action === 'reset') {
      const ok = await resetCognee()
      await writeAudit({
        userId: user.userId,
        action: 'COGNEE_RESET',
        severity: 'warning',
        detail: { reset: ok },
      })
      return NextResponse.json({ ok, data: { reset: ok } })
    }

    if (action === 'forget_kb') {
      const ok = await forgetKnowledgeGraph()
      await writeAudit({
        userId: user.userId,
        action: 'COGNEE_FORGET_KB',
        severity: 'warning',
        detail: { forgotten: ok },
      })
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
