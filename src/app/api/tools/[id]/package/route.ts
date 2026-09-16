/**
 * Plugin package export — `GET /api/tools/[id]/package`
 *
 * Returns a portable, shareable package for one registered plugin, so an
 * operator can hand a plugin to another install. Credentials are STRIPPED by
 * `exportPluginPackage`: a package is meant to be shared, and shipping the
 * author's secret would leak it the moment it left the machine.
 *
 * The response is downloadable rather than inline JSON so the browser saves it
 * as a file — the point of the endpoint is to produce an artifact.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { exportPluginPackage, serializePluginPackage } from '@/lib/plugin-package'

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params
    enterWithOrg((await getActiveUser()).organizationId)

    // `findFirst`, never the unscoped single-row lookup: the id is
    // client-supplied and that lookup is not org-scoped, so using it here would
    // let an org export another org's plugin by id — the cross-tenant IDOR this
    // codebase already fixed once (see the guard in invariants.test.ts).
    const plugin = await db.plugin.findFirst({
      where: { id },
      select: {
        toolId: true, name: true, description: true,
        category: true, subcategory: true, keywords: true, manifestJson: true,
      },
    })
    if (!plugin) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Plugin not found.' } }, { status: 404 })
    }

    const pkg = exportPluginPackage(plugin)
    if ('error' in pkg) {
      return NextResponse.json({ error: { code: 'INVALID_PLUGIN', message: pkg.error } }, { status: 422 })
    }

    return new NextResponse(serializePluginPackage(pkg), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // The filename is built from the plugin's own toolId, which is already
        // constrained to [a-zA-Z0-9_-] at registration, so it cannot inject
        // header syntax. Quoted per RFC 6266.
        'Content-Disposition': `attachment; filename="plugin-${plugin.toolId}.json"`,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to export the plugin package.')
  }
}
