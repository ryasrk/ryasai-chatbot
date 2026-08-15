import { enterWithOrg } from '@/lib/prisma-tenant'
/**
 * POST /api/integrations/[id]/init-context — generate or refresh the LLM
 * business context for an integration.
 *
 * Called by the "Initialize Context" button in the integrations UI. This:
 *   1. Re-runs schema enrichment (table descriptions)
 *   2. Generates the business context profile (domain, glossary, relationships,
 *      query hints) and saves it to Integration.businessContext
 *
 * Returns the generated context so the UI can display it immediately.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'

interface RouteCtx {
  params: Promise<{ id: string }>
}

export async function POST(_req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const { id } = await ctx.params

    const integration = await db.integration.findFirst({
      where: { id },
      select: { id: true, name: true, provider: true, organizationId: true },
    })

    if (!integration) {
      return NextResponse.json(
        { ok: false, error: 'Integration not found.' },
        { status: 404 },
      )
    }

    // 1. Re-run schema enrichment (table-level descriptions)
    const { enrichSchemaDescriptions } = await import('@/lib/schema-enrichment')
    await enrichSchemaDescriptions(id, integration.name)

    // 2. Generate the business context profile
    const { generateDatabaseProfile } = await import('@/lib/ai')
    const { safeParseColumns, safeParseSampleRow } = await import('@/lib/schema-enrichment')

    const fullIntegration = await db.integration.findUnique({
      where: { id },
      include: { schemas: { select: { tableName: true, columns: true, rowCount: true, sampleRow: true } } },
    })

    if (!fullIntegration || fullIntegration.schemas.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No schema found. Run "Test Connection" first to reflect the schema.' },
        { status: 400 },
      )
    }

    const tables = fullIntegration.schemas.map((s) => ({
      tableName: s.tableName,
      columns: safeParseColumns(s.columns),
      rowCount: s.rowCount,
      sampleRow: safeParseSampleRow(s.sampleRow),
    }))

    const profile = await generateDatabaseProfile({
      integrationName: integration.name,
      tables,
    })

    if (profile) {
      await db.integration.update({
        where: { id },
        data: { businessContext: profile },
      })
    }

    await writeAudit({
      userId: user.userId,
      action: 'INTEGRATION_CONTEXT_INIT',
      severity: 'info',
      detail: { integrationId: id, name: integration.name, contextLength: profile.length },
    })

    return NextResponse.json({
      ok: true,
      data: {
        id,
        businessContext: profile,
        contextLength: profile.length,
        tableCount: fullIntegration.schemas.length,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to initialize business context.')
  }
}
