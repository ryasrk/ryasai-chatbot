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
    const user = await getActiveUser()

    const integrations = await db.integration.findMany({
      where: { companyId: user.companyId },
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
    return handleApiError(e, 'Gagal memuat daftar integrasi.')
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
    return { ok: false as const, status: 400, error: 'Nama integrasi wajib diisi.' }
  }
  if (type !== 'DATABASE') {
    return {
      ok: false as const,
      status: 400,
      error:
        "Endpoint /api/integrations khusus database. Untuk REST API gunakan /api/data-sources/rest-connectors.",
    }
  }
  if (!ALLOWED_DATABASE_PROVIDERS.has(provider)) {
    return {
      ok: false as const,
      status: 400,
      error: `Provider database tidak didukung. Pilihan: ${[...ALLOWED_DATABASE_PROVIDERS].join(', ')}`,
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

    // Encrypt config (AES-256-GCM) before persistence — spec §4.2
    const encryptedConfig = encryptConfig(config as Record<string, unknown>)

    // Create the integration row (status=active by default; will be updated after test).
    const integration = await db.integration.create({
      data: {
        companyId: user.companyId,
        name,
        type,
        provider,
        encryptedConfig,
        status: 'active',
      },
    })

    // Spec §3.1: build connector + test connection + reflect schema
    let lastTestOk = false
    let testMessage = ''
    let reflectedTables: ReflectedTable[] = []
    try {
      const connector = connectorRegistry.getConnector(
        integration.id,
        provider,
        config as Record<string, unknown>,
      )
      lastTestOk = await connector.testConnection()
      if (lastTestOk) {
        reflectedTables = await connector.fetchSchema()
        // cache schema rows
        if (reflectedTables.length > 0) {
          await db.integrationSchema.deleteMany({ where: { integrationId: integration.id } }).catch(() => {})
          await db.integrationSchema.createMany({
            data: reflectedTables.map((t) => ({
              integrationId: integration.id,
              tableName: t.tableName,
              columns: JSON.stringify(t.columns ?? []),
              rowCount: t.rowCount ?? null,
            })),
          })
        }
        testMessage = `Koneksi berhasil. ${reflectedTables.length} tabel terdeteksi.`
      } else {
        testMessage = 'Koneksi gagal — periksa kredensial / jaringan.'
        await db.integration.update({
          where: { id: integration.id },
          data: { status: 'error' },
        })
      }
    } catch (e) {
      lastTestOk = false
      testMessage = e instanceof Error ? e.message : 'Kesalahan tidak dikenal saat koneksi.'
      await db.integration.update({
        where: { id: integration.id },
        data: { status: 'error' },
      })
    }

    await db.integration.update({
      where: { id: integration.id },
      data: {
        lastTestedAt: new Date(),
        lastTestOk,
      },
    })

    // Audit — spec §7
    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'INTEGRATION_CREATE',
      severity: lastTestOk ? 'info' : 'warning',
      detail: {
        integrationId: integration.id,
        name,
        type,
        provider,
        lastTestOk,
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
          status: lastTestOk ? 'active' : 'error',
          lastTestedAt: new Date(),
          lastTestOk,
          tableCount: reflectedTables.length,
          message: testMessage,
        },
      },
      { status: 201 },
    )
  } catch (e) {
    return handleApiError(e, 'Gagal membuat integrasi.')
  }
}
