/**
 * Plugin package install — `POST /api/tools/install`
 *
 * Validates a shared plugin package and describes exactly what installing it
 * would do, WITHOUT writing anything. The operator reviews `warnings` (which
 * endpoint it calls, which process it runs, which credential it needs) and then
 * commits through the existing plugin-create route.
 *
 * WHY PLANNING IS SEPARATE FROM WRITING. Installing a plugin can mean spawning a
 * local process or pointing requests at someone's endpoint. An endpoint that
 * wrote on first sight would make the review step impossible, and a single
 * request that both validates and commits cannot be shown to the operator before
 * the fact. Two calls is the price of an approval step that actually means
 * something.
 *
 * Admin-only: even though this writes nothing, it reads and echoes a
 * third-party manifest and is part of the install flow.
 */
import { NextResponse } from 'next/server'
import { getActiveUser, handleApiError, requireRole, writeAudit } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { planPluginInstall } from '@/lib/plugin-package'

export async function POST(req: Request) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Body must be a JSON plugin package.' } },
        { status: 400 },
      )
    }

    // A package may arrive either as the package object itself or as a string
    // holding it (a pasted file). Both are accepted — a paste is the common way
    // an operator moves a package between installs.
    const candidate = typeof body === 'string' ? safeParse(body) : body
    if (candidate === undefined) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'That text is not valid JSON.' } },
        { status: 400 },
      )
    }

    const plan = planPluginInstall(candidate)
    if ('error' in plan) {
      // 422: the package parsed as JSON but is not installable (bad integrity,
      // unsupported version, unsafe command). Audited because a rejected install
      // is worth seeing — it may be a tampered or hostile package.
      // writeAudit resolves the org from the ambient context itself.
      await writeAudit({
        userId: user.userId,
        action: 'PLUGIN_INSTALL_REJECTED',
        severity: 'warning',
        detail: { reason: plan.error },
      }).catch(() => undefined)
      return NextResponse.json({ error: { code: 'PACKAGE_REJECTED', message: plan.error } }, { status: 422 })
    }

    return NextResponse.json({
      ok: true,
      plan: {
        toolId: plan.toolId,
        name: plan.name,
        description: plan.description,
        category: plan.category,
        subcategory: plan.subcategory,
        keywords: plan.keywords,
        manifest: JSON.parse(plan.manifestJson) as unknown,
        manifestDigest: plan.manifestDigest,
        warnings: plan.warnings,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to plan the plugin install.')
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
