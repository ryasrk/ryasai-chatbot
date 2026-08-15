import { enterWithOrg } from '@/lib/prisma-tenant'
/**
 * POST /api/integrations/[id]/test — re-test a saved integration.
 * ----------------------------------------------------------------------------
 * The Integrations UI ("Test Connection" button) calls this endpoint. It:
 *   1. Loads the integration + decrypts its stored credentials.
 *   2. Opens a fresh connector (bypassing any cached pool) and runs SELECT 1.
 *   3. On success, re-reflects the schema cache and refreshes lastTestOk.
 *   4. On failure, updates status/lastTestOk and returns a DIAGNOSTIC error
 *      message (SSL / auth / DNS / timeout hints) instead of a generic string,
 *      so users can tell a wrong password from a TLS mismatch.
 *
 * ponytail: this route existed in the UI contract (integrations-view.tsx calls
 * `/api/integrations/${id}/test`) but was never implemented — every test click
 * 404'd and looked like "connection failed".
 *
 * Server-only route handler. No 'use client'.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { decryptConfig } from '@/lib/crypto'
import { connectorRegistry, type ReflectedTable } from '@/lib/connectors'
import { describeConnectionError } from '@/lib/real-connectors'
import { invalidateSourceEmbeddingCache } from '@/lib/smart-router'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function POST(_req: NextRequest, ctx: RouteCtx) {
  let tempId = ''
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    const { id } = await ctx.params

    const integration = await db.integration.findFirst({
      where: { id },
      select: {
        id: true,
        name: true,
        provider: true,
        status: true,
        encryptedConfig: true,
        organizationId: true,
      },
    })

    if (!integration) {
      return NextResponse.json(
        { ok: false, error: 'Integration not found.' },
        { status: 404 },
      )
    }

    // ponytail: fresh connector on a throwaway id — never reuse a cached pool
    // whose credentials/socket may be stale; dropped in finally.
    tempId = `test_${id}_${Date.now()}`
    const connector = connectorRegistry.getConnector(
      tempId,
      integration.provider,
      decryptConfig(integration.encryptedConfig),
    )

    const testResult = connector.testConnectionDetailed
      ? await connector.testConnectionDetailed()
      : { ok: await connector.testConnection(), message: 'Connection failed. Check credentials and network.' }

    if (!testResult.ok) {
      // Record the failure on the row (status unchanged — admin decides).
      await db.integration
        .update({
          where: { id },
          data: { lastTestedAt: new Date(), lastTestOk: false },
        })
        .catch(() => {})
      await writeAudit({
        userId: user.userId,
        action: 'INTEGRATION_TEST_FAILED',
        severity: 'warning',
        detail: {
          integrationId: id,
          name: integration.name,
          provider: integration.provider,
          reason: testResult.reason,
        },
      }).catch(() => {})
      // ok:false + 200 — the UI contract treats non-2xx as a transport error
      // and shows a toast; we want the diagnostic message surfaced instead.
      return NextResponse.json({
        ok: false,
        message: testResult.message,
        reason: testResult.reason,
      })
    }

    // Connection healthy — refresh the schema cache too, so "Test" doubles as
    // "pick up newly created tables".
    let tablesCount = 0
    try {
      const tables: ReflectedTable[] = await connector.fetchSchema()
      tablesCount = tables.length
      if (tables.length > 0) {
        await db.integrationSchema.deleteMany({ where: { integrationId: id } }).catch(() => {})
        await db.integrationSchema.createMany({
          data: tables.map((t) => ({
            organizationId: integration.organizationId,
            integrationId: id,
            tableName: t.tableName,
            columns: JSON.stringify(t.columns ?? []),
            rowCount: t.rowCount ?? null,
            sampleRow: t.sampleRow ? JSON.stringify(t.sampleRow) : null,
          })),
        })
        invalidateSourceEmbeddingCache()
      }
    } catch (e) {
      // SELECT 1 worked but reflection failed — still a pass, but say so.
      console.error(`[integrations/test] schema refresh failed for ${id}:`, e)
    }

    await db.integration.update({
      where: { id },
      data: { lastTestedAt: new Date(), lastTestOk: true, status: 'active' },
    })

    // ponytail: refresh LLM table descriptions after re-reflection — tables
    // created since the last init have no description yet, so the SQL prompt
    // would render them bare. Fire-and-forget, never blocks the response.
    if (tablesCount > 0) {
      const { enrichSchemaDescriptions } = await import('@/lib/schema-enrichment')
      void enrichSchemaDescriptions(id, integration.name).catch(() => null)
      // Also regenerate the business context profile (domain, glossary, hints)
      const { initIntegrationContext } = await import('@/lib/source-init')
      void initIntegrationContext(id).catch(() => null)
    }

    await writeAudit({
      userId: user.userId,
      action: 'INTEGRATION_TEST',
      severity: 'info',
      detail: { integrationId: id, name: integration.name, provider: integration.provider, tablesCount },
    })

    return NextResponse.json({
      ok: true,
      data: {
        id,
        lastTestedAt: new Date().toISOString(),
        lastTestOk: true,
        tablesCount,
      },
      tablesCount,
    })
  } catch (e) {
    return handleApiError(e, 'Failed to test connection.')
  } finally {
    // Always drop the throwaway connector so its pool doesn't linger.
    if (tempId) connectorRegistry.drop(tempId)
  }
}

// Re-exported for tests — keeps the diagnostic mapper with its route.
export { describeConnectionError }
