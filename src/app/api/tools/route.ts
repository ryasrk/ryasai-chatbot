import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import {
  encryptPluginCredentials,
  maskPluginManifest,
  normalizeManifest,
  parsePluginManifest,
  type PluginManifest,
} from '@/lib/plugin-registry'

interface CreatePluginBody {
  toolId?: string
  name?: string
  description?: string
  manifest?: PluginManifest
  category?: string
  keywords?: string
  chatEnabled?: boolean
  agenticEnabled?: boolean
}

export async function GET() {
  try {
    await getActiveUser()
    const plugins = await db.plugin.findMany({
      where: {},
      orderBy: [{ category: 'asc' }, { subcategory: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        toolId: true,
        name: true,
        description: true,
        manifestJson: true,
        isEnabled: true,
        chatEnabled: true,
        agenticEnabled: true,
        category: true,
        subcategory: true,
        keywords: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    const items = plugins.map((p) => {
      const manifest = parsePluginManifest(p.manifestJson)
      return {
        id: p.id,
        toolId: p.toolId,
        name: p.name,
        description: p.description,
        manifest: manifest ? maskPluginManifest(manifest) : null,
        isEnabled: p.isEnabled,
        chatEnabled: p.chatEnabled,
        agenticEnabled: p.agenticEnabled,
        category: p.category,
        subcategory: p.subcategory,
        keywords: p.keywords,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }
    })

    return NextResponse.json({ ok: true, plugins: items })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat daftar plugin.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()

    const body = (await req.json().catch(() => ({}))) as CreatePluginBody

    const toolId = (body.toolId ?? '').trim()
    if (!toolId) {
      return NextResponse.json({ ok: false, error: 'toolId wajib diisi.' }, { status: 400 })
    }
    const name = (body.name ?? '').trim()
    if (!name) {
      return NextResponse.json({ ok: false, error: 'Nama plugin wajib diisi.' }, { status: 400 })
    }
    const description = (body.description ?? '').trim()

    const manifest = normalizeManifest(body.manifest)
    if ('error' in manifest) {
      return NextResponse.json({ ok: false, error: manifest.error }, { status: 400 })
    }

    // toolId must be unique per tenant — planner uses it as a stable key
    const existing = await db.plugin.findFirst({
      where: { toolId },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { ok: false, error: `Plugin dengan toolId "${toolId}" sudah ada.` },
        { status: 409 },
      )
    }

    // Encrypt credentials at rest (AES-256-GCM policy, same as integration configs)
    if (manifest.authCredentials && manifest.authType !== 'NONE') {
      manifest.authCredentials = encryptPluginCredentials(manifest.authCredentials)
    }

    const plugin = await db.plugin.create({
      data: {
        toolId,
        name,
        description,
        manifestJson: JSON.stringify(manifest),
        isEnabled: false,
        chatEnabled: typeof body.chatEnabled === 'boolean' ? body.chatEnabled : true,
        agenticEnabled: typeof body.agenticEnabled === 'boolean' ? body.agenticEnabled : true,
        category: (body.category ?? 'general').trim() || 'general',
        keywords: (body.keywords ?? '').trim(),
      },
      select: {
        id: true,
        toolId: true,
        name: true,
        description: true,
        isEnabled: true,
        chatEnabled: true,
        agenticEnabled: true,
        createdAt: true,
      },
    })

    await writeAudit({
      userId: user.userId,
      action: 'PLUGIN_CREATE',
      severity: 'warning',
      detail: { pluginId: plugin.id, toolId: plugin.toolId, name: plugin.name },
    })

    return NextResponse.json({ ok: true, data: plugin }, { status: 201 })
  } catch (e) {
    return handleApiError(e, 'Gagal membuat plugin.')
  }
}
