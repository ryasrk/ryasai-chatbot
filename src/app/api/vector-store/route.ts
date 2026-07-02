import { NextRequest, NextResponse } from 'next/server'
import { encryptConfig } from '@/lib/crypto'
import { db } from '@/lib/db'
import { ensureVectorCollection, getVectorStoreRuntimeConfig } from '@/lib/vector-stores'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { maskSecret, normalizeBaseUrl } from '@/lib/llm-config'

export async function GET() {
  try {
    const user = await getActiveUser()
    const row = await db.vectorStoreConfig.findUnique({ where: { companyId: user.companyId } })
    return NextResponse.json({
      ok: true,
      data: row
        ? {
            provider: row.provider,
            baseUrl: row.baseUrl ?? '',
            apiKeyMasked: row.encryptedApiKey ? maskSecret('configured-key') : null,
            collectionName: row.collectionName,
            vectorSize: row.vectorSize,
            distance: row.distance,
            updatedAt: row.updatedAt.toISOString(),
          }
        : {
            provider: 'INTERNAL',
            baseUrl: '',
            apiKeyMasked: null,
            collectionName: 'ryasai_chunks',
            vectorSize: 1536,
            distance: 'Cosine',
            updatedAt: null,
          },
    })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat konfigurasi vector DB.')
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getActiveUser()
    if (user.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Hanya admin.' }, { status: 403 })
    }
    const body = (await req.json().catch(() => ({}))) as {
      provider?: string
      baseUrl?: string
      apiKey?: string
      collectionName?: string
      vectorSize?: number
      distance?: string
    }
    const provider = (body.provider ?? 'INTERNAL').trim().toUpperCase()
    const baseUrl = body.baseUrl?.trim() ? normalizeBaseUrl(body.baseUrl) : null
    const collectionName = (body.collectionName ?? 'ryasai_chunks').trim() || 'ryasai_chunks'
    const vectorSize = Math.max(1, Number(body.vectorSize ?? 1536) || 1536)
    const distance = (body.distance ?? 'Cosine').trim() || 'Cosine'
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    const existing = await db.vectorStoreConfig.findUnique({ where: { companyId: user.companyId } })

    await db.vectorStoreConfig.upsert({
      where: { companyId: user.companyId },
      update: {
        provider,
        baseUrl,
        collectionName,
        vectorSize,
        distance,
        ...(apiKey ? { encryptedApiKey: encryptConfig({ apiKey }) } : {}),
      },
      create: {
        companyId: user.companyId,
        provider,
        baseUrl,
        collectionName,
        vectorSize,
        distance,
        encryptedApiKey: apiKey ? encryptConfig({ apiKey }) : existing?.encryptedApiKey,
      },
    })

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'VECTOR_STORE_CONFIG_UPDATE',
      severity: 'warning',
      detail: { provider, baseUrl, collectionName, vectorSize, distance, keyRotated: !!apiKey },
    })
    return GET()
  } catch (e) {
    return handleApiError(e, 'Gagal menyimpan konfigurasi vector DB.')
  }
}

export async function POST() {
  try {
    const user = await getActiveUser()
    if (user.role !== 'admin') {
      return NextResponse.json({ ok: false, error: 'Hanya admin.' }, { status: 403 })
    }
    const config = await getVectorStoreRuntimeConfig(user.companyId)
    if (!config) return NextResponse.json({ ok: true, data: { provider: 'INTERNAL' } })
    await ensureVectorCollection(config)
    return NextResponse.json({ ok: true, data: { provider: config.provider, collectionName: config.collectionName } })
  } catch (e) {
    return handleApiError(e, 'Gagal menguji vector DB.', 502)
  }
}
