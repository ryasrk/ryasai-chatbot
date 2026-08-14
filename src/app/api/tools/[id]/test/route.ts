import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { executePlugin } from '@/lib/plugin-registry'

/**
 * POST /api/tools/[id]/test — invoke a saved plugin with a test input.
 *
 * The custom-tools tab calls this from its Test dialog with { input }.
 * Contract: { ok, result: { ok, output, error?, latencyMs } } — the UI reads
 * data.result on success and data.error on failure.
 *
 * ponytail: no bypass of executePlugin's guards — the test goes through the
 * same SSRF/host checks, auth decryption, timeout and output cap as a real
 * agentic invocation. A test button that bypasses guardrails would be an
 * SSRF oracle.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as { input?: string }
    const input = (body.input ?? '').trim()

    const plugin = await db.plugin.findFirst({
      where: { id },
      select: { id: true, toolId: true, name: true, manifestJson: true, isEnabled: true },
    })
    if (!plugin) {
      return NextResponse.json({ ok: false, error: 'Plugin not found.' }, { status: 404 })
    }
    if (!plugin.isEnabled) {
      return NextResponse.json({ ok: false, error: 'Plugin is disabled.' }, { status: 409 })
    }

    const result = await executePlugin({
      plugin: { manifestJson: plugin.manifestJson, toolId: plugin.toolId },
      input,
    })

    await writeAudit({
      userId: user.userId,
      action: result.ok ? 'PLUGIN_TEST' : 'PLUGIN_TEST_FAILED',
      severity: 'info',
      detail: { pluginId: id, toolId: plugin.toolId, latencyMs: result.latencyMs, ok: result.ok },
    }).catch(() => {})

    return NextResponse.json({ ok: true, result })
  } catch (e) {
    return handleApiError(e, 'Failed to test plugin.')
  }
}
