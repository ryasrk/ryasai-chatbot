import { NextRequest, NextResponse } from 'next/server'
import { db, isPrismaNotFound } from '@/lib/db'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import {
  encryptPluginCredentials,
  maskPluginManifest,
  normalizeManifest,
  parsePluginManifest,
  type PluginManifest,
} from '@/lib/plugin-registry'

interface RouteContext {
  params: Promise<{ id: string }>
}
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { id } = await ctx.params
    const plugin = await db.plugin.findFirst({ // nosemgrep
      where: { id },
    })
    if (!plugin) {
      return NextResponse.json({ ok: false, error: 'Plugin not found.' }, { status: 404 })
    }
    const manifest = parsePluginManifest(plugin.manifestJson)
    return NextResponse.json({
      ok: true,
      plugin: {
        ...plugin,
        manifest: manifest ? maskPluginManifest(manifest) : null,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load plugin.')
  }
}

interface PatchBody {
  name?: string
  description?: string
  isEnabled?: boolean
  chatEnabled?: boolean
  agenticEnabled?: boolean
  manifest?: PluginManifest
  category?: string
  keywords?: string
}

export async function PATCH(req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)

    const { id } = await ctx.params
    const existing = await db.plugin.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, toolId: true, name: true, manifestJson: true },
    })
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'Plugin not found.' }, { status: 404 })
    }

    const body = (await req.json().catch(() => ({}))) as PatchBody
    const data: {
      name?: string
      description?: string
      isEnabled?: boolean
      chatEnabled?: boolean
      agenticEnabled?: boolean
      manifestJson?: string
      category?: string
      keywords?: string
    } = {}

    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
    if (typeof body.description === 'string') data.description = body.description.trim()
    if (typeof body.isEnabled === 'boolean') data.isEnabled = body.isEnabled
    if (typeof body.chatEnabled === 'boolean') data.chatEnabled = body.chatEnabled
    if (typeof body.agenticEnabled === 'boolean') data.agenticEnabled = body.agenticEnabled
    if (typeof body.category === 'string' && body.category.trim()) data.category = body.category.trim()
    if (typeof body.keywords === 'string') data.keywords = body.keywords.trim()

    if (body.manifest) {
      const manifest = normalizeManifest(body.manifest)
      if ('error' in manifest) {
        return NextResponse.json({ ok: false, error: manifest.error }, { status: 400 })
      }
      // Preserve existing encrypted credentials when the editor sends no new
      // value (the UI masks credentials as ••••, so blank = "keep current").
      if (!manifest.authCredentials && manifest.authType !== 'NONE') {
        const prev = parsePluginManifest(existing.manifestJson)
        if (prev?.authCredentials) {
          manifest.authCredentials = prev.authCredentials
        }
      } else if (manifest.authCredentials && manifest.authType !== 'NONE') {
        manifest.authCredentials = encryptPluginCredentials(manifest.authCredentials)
      }
      data.manifestJson = JSON.stringify(manifest)
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No fields provided for update.' },
        { status: 400 },
      )
    }

    const updated = await db.plugin.update({
      where: { id: existing.id },
      data,
      select: { id: true, toolId: true, name: true, description: true, isEnabled: true, chatEnabled: true, agenticEnabled: true, updatedAt: true },
    }).catch((e: unknown) => {
      if (isPrismaNotFound(e)) return null
      throw e
    })
    if (!updated) {
      return NextResponse.json({ ok: false, error: 'Plugin not found.' }, { status: 404 })
    }

    await writeAudit({
      userId: user.userId,
      action: 'PLUGIN_UPDATE',
      severity: 'info',
      detail: { id: updated.id, toolId: updated.toolId, changes: data },
    })

    return NextResponse.json({ ok: true, plugin: updated })
  } catch (e) {
    return handleApiError(e, 'Failed to update plugin.')
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)

    const { id } = await ctx.params
    const existing = await db.plugin.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, toolId: true, name: true },
    })
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'Plugin not found.' }, { status: 404 })
    }

    const result = await db.plugin.deleteMany({ where: { id } })
    if (result.count === 0) {
      return NextResponse.json({ ok: false, error: 'Plugin not found.' }, { status: 404 })
    }

    await writeAudit({
      userId: user.userId,
      action: 'PLUGIN_DELETE',
      severity: 'warning',
      detail: { id: existing.id, toolId: existing.toolId, name: existing.name },
    })

    return NextResponse.json({ ok: true, deleted: true })
  } catch (e) {
    return handleApiError(e, 'Failed to delete plugin.')
  }
}
