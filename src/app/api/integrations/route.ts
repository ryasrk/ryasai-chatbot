/**
 * Spec §3.1 (Dynamic Connector Factory) + §3.2 (Registry) + §5.1 (POST /api/v1/integrations/connect)
 * ----------------------------------------------------------------------------
 * GET  /api/integrations        — list integrations for the active user's company
 * POST /api/integrations        — create a new integration (encrypt config, test, reflect schema)
 *
 * Server-only route handler. No 'use client'.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { encryptConfig } from '@/lib/crypto'
import { connectorRegistry, type ReflectedTable } from '@/lib/connectors'

const ALLOWED_DATABASE_PROVIDERS = new Set(['POSTGRESQL', 'MYSQL', 'MSSQL', 'SQLITE_DEMO'])

export async function GET(_req: NextRequest) {
  try {
    await getActiveUser()

    const integrations = await db.integration.findMany({
      where: {},
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        type: true,
        provider: true,
        status: true,
        lastTestedAt: true,
        lastTestOk: true,
        createdAt: true,
        _count: { select: { schemas: true } },
      },
    })

    const data = integrations.map((i) => ({
      id: i.id,
      name: i.name,
      type: i.type,
      provider: i.provider,
      status: i.status,
      lastTestedAt: i.lastTestedAt,
      lastTestOk: i.lastTestOk,
      createdAt: i.createdAt,
      tableCount: i._count.schemas,
    }))

    return NextResponse.json({ ok: true, data })
  } catch (e) {
    return handleApiError(e, 'Failed to load integration list.')
  }
}

export interface CreateBody {
  name?: string
  type?: string
  provider?: string
  config?: {
    host?: string
    port?: number | string
    username?: string
    password?: string
    database_name?: string
    [k: string]: unknown
  }
}

export function validateCreateIntegrationInput(body: CreateBody) {
  const name = (body.name ?? '').trim()
  const type = (body.type ?? '').toUpperCase()
  const provider = (body.provider ?? '').toUpperCase()
  const config = body.config ?? {}

  if (!name) {
    return { ok: false as const, status: 400, error: 'Integration name is required.' }
  }
  if (type !== 'DATABASE') {
    return {
      ok: false as const,
      status: 400,
      error:
        "Endpoint /api/integrations is database-only. For REST API use /api/data-sources/rest-connectors.",
    }
  }
  if (!ALLOWED_DATABASE_PROVIDERS.has(provider)) {
    return {
      ok: false as const,
      status: 400,
      error: `Database provider not supported. Options: ${[...ALLOWED_DATABASE_PROVIDERS].join(', ')}`,
    }
  }

  return { ok: true as const, name, type, provider, config }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    const body = (await req.json().catch(() => ({}))) as CreateBody

    const validation = validateCreateIntegrationInput(body)
    if (!validation.ok) {
      return NextResponse.json(
        { ok: false, error: validation.error },
        { status: validation.status },
      )
    }
    const { name, type, provider, config } = validation

    // Test connection BEFORE persisting — no orphan rows on failure
    const tempId = `temp_${Date.now()}`
    let reflectedTables: ReflectedTable[] = []
    try {
      const connector = connectorRegistry.getConnector(
        tempId,
        provider,
        config as Record<string, unknown>,
      )
      const testOk = await connector.testConnection()
      if (!testOk) {
        connectorRegistry.drop(tempId)
        return NextResponse.json(
          { ok: false, error: 'Connection failed. Check credentials and network.' },
          { status: 400 },
        )
      }
      reflectedTables = await connector.fetchSchema()
      connectorRegistry.drop(tempId)
    } catch (e) {
      connectorRegistry.drop(tempId)
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : 'Unknown error during connection.' },
        { status: 400 },
      )
    }

    // Persist only on successful connection
    const encryptedConfig = encryptConfig(config as Record<string, unknown>)
    const integration = await db.integration.create({
      data: {
        name,
        type,
        provider,
        encryptedConfig,
        status: 'active',
      },
    })

    // Cache schema rows
    if (reflectedTables.length > 0) {
      await db.integrationSchema.deleteMany({ where: { integrationId: integration.id } }).catch(() => {})
      await db.integrationSchema.createMany({
        data: reflectedTables.map((t) => ({
          integrationId: integration.id,
          tableName: t.tableName,
          columns: JSON.stringify(t.columns ?? []),
          rowCount: t.rowCount ?? null,
          sampleRow: t.sampleRow ? JSON.stringify(t.sampleRow) : null,
        })),
      })
    }

    await db.integration.update({
      where: { id: integration.id },
      data: {
        lastTestedAt: new Date(),
        lastTestOk: true,
      },
    })

    // Audit — spec §7
    await writeAudit({
      userId: user.userId,
      action: 'INTEGRATION_CREATE',
      severity: 'info',
      detail: {
        integrationId: integration.id,
        name,
        type,
        provider,
        lastTestOk: true,
        tablesReflected: reflectedTables.length,
      },
    })

    return NextResponse.json(
      {
        ok: true,
        data: {
          id: integration.id,
          name,
          type,
          provider,
          status: 'active',
          lastTestedAt: new Date(),
          lastTestOk: true,
          tableCount: reflectedTables.length,
          message: `Connection successful. ${reflectedTables.length} tables detected.`,
        },
      },
      { status: 201 },
    )
  } catch (e) {
    return handleApiError(e, 'Failed to create integration.')
  }
}
