import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { executeRestRequest } from '@/lib/tool-branches'

/**
 * POST /api/data-sources/rest-connectors/[id]/test — fire a real request
 * through a saved connector, with the connector's auth and guards.
 *
 * Body: { method, path, query?, body? }
 * The REST connector sheet's "Test" tab calls this. It was in the UI contract
 * but never implemented — the test button 404'd.
 *
 * ponytail: reuse executeRestRequest (the production REST path) instead of a
 * bespoke fetch — that keeps the SSRF host checks, decrypted auth headers,
 * RestApiRequestLog telemetry and connector timeout identical between the
 * test button and real agentic calls. A test-only path would drift.
 *
 * Unlike agentic calls, the test does NOT require the path to be whitelisted:
 * admins probe endpoints before saving them to the whitelist. It is still
 * admin-only and still SSRF-guarded.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as {
      method?: string
      path?: string
      query?: Record<string, unknown>
      body?: unknown
    }

    const method = (body.method ?? 'GET').trim().toUpperCase()
    const path = (body.path ?? '').trim()
    if (!path) {
      return NextResponse.json({ ok: false, error: 'Test path is required.' }, { status: 400 })
    }
    if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/.test(method)) {
      return NextResponse.json({ ok: false, error: `Unsupported method: ${method}.` }, { status: 400 })
    }

    const connector = await db.restApiConnector.findFirst({
      where: { id },
      select: { id: true, name: true, baseUrl: true, authType: true, encryptedAuthConfig: true, timeoutMs: true },
    })
    if (!connector) {
      return NextResponse.json({ ok: false, error: 'Connector not found.' }, { status: 404 })
    }

    const result = await executeRestRequest({
      connector,
      // endpointId null — this is a manual probe, not a whitelisted endpoint run.
      endpointId: null as unknown as string,
      method,
      path,
      plan: {
        endpointId: '',
        explanation: 'Manual test from connector sheet',
        query: (body.query ?? {}) as Record<string, string | number | boolean | null>,
        body: body.body ?? null,
      },
    })

    if (result.ok) {
      await writeAudit({
        userId: user.userId,
        action: 'REST_CONNECTOR_TEST',
        severity: 'info',
        detail: { connectorId: id, method, path, statusCode: result.statusCode, latencyMs: result.latencyMs },
      }).catch(() => {})
      return NextResponse.json({
        ok: true,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        body: result.body,
        bodyText: result.bodyText,
      })
    }

    return NextResponse.json({
      ok: false,
      error: result.error,
      latencyMs: result.latencyMs,
    })
  } catch (e) {
    return handleApiError(e, 'Failed to test REST connector.')
  }
}
