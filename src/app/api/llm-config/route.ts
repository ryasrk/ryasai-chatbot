/**
 * LLM configuration — OpenAI-compatible provider settings per tenant.
 * ----------------------------------------------------------------------------
 * GET  /api/llm-config        — current config (API key masked)
 * PUT  /api/llm-config        — upsert provider/baseUrl/apiKey/model (admin-only)
 *
 * The API key is AES-256-GCM encrypted at rest (src/lib/crypto.ts).
 * Model discovery lives at POST /api/llm-config/models.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { getPublicLlmConfig, normalizeBaseUrl } from '@/lib/llm-config'
import { encryptConfig } from '@/lib/crypto'
import { db } from '@/lib/db'

export async function GET() {
  try {
    const user = await getActiveUser()
    const data = await getPublicLlmConfig(user.companyId)
    return NextResponse.json({ ok: true, data })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat konfigurasi LLM.')
  }
}

interface PutBody {
  provider?: string
  baseUrl?: string
  apiKey?: string
  model?: string
  embeddingProvider?: string
  embeddingBaseUrl?: string
  embeddingApiKey?: string
  embeddingModel?: string
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getActiveUser()

    if (user.role !== 'admin') {
      return NextResponse.json(
        { ok: false, error: 'Hanya admin yang dapat mengubah konfigurasi LLM.' },
        { status: 403 },
      )
    }

    const body = (await req.json().catch(() => ({}))) as PutBody
    const provider = (body.provider ?? 'OPENAI_COMPATIBLE').trim().toUpperCase() || 'OPENAI_COMPATIBLE'
    const model = (body.model ?? '').trim()
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    const embeddingProvider =
      (body.embeddingProvider ?? 'OPENAI_COMPATIBLE').trim().toUpperCase() ||
      'OPENAI_COMPATIBLE'
    const embeddingModel = (body.embeddingModel ?? '').trim()
    const embeddingApiKey =
      typeof body.embeddingApiKey === 'string' ? body.embeddingApiKey.trim() : ''

    let baseUrl: string
    let embeddingBaseUrl: string | null = null
    try {
      baseUrl = normalizeBaseUrl(body.baseUrl ?? '')
      if (body.embeddingBaseUrl && body.embeddingBaseUrl.trim()) {
        embeddingBaseUrl = normalizeBaseUrl(body.embeddingBaseUrl)
      }
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : 'Base URL tidak valid.' },
        { status: 400 },
      )
    }

    const existing = await db.llmConfig.findUnique({ where: { companyId: user.companyId } })

    // apiKey is required on first create; on update, a blank value keeps the existing key.
    if (!apiKey && !existing) {
      return NextResponse.json(
        { ok: false, error: 'API key wajib diisi pada konfigurasi pertama.' },
        { status: 400 },
      )
    }

    const finalModel = model || existing?.model || ''
    const encryptedApiKey = apiKey
      ? encryptConfig({ apiKey })
      : existing!.encryptedApiKey
    const encryptedEmbeddingApiKey = embeddingApiKey
      ? encryptConfig({ apiKey: embeddingApiKey })
      : existing?.encryptedEmbeddingApiKey

    await db.llmConfig.upsert({
      where: { companyId: user.companyId },
      update: {
        provider,
        baseUrl,
        model: finalModel,
        ...(apiKey ? { encryptedApiKey } : {}),
        embeddingProvider,
        embeddingBaseUrl: embeddingBaseUrl ?? baseUrl,
        embeddingModel,
        ...(embeddingApiKey ? { encryptedEmbeddingApiKey } : {}),
      },
      create: {
        companyId: user.companyId,
        provider,
        baseUrl,
        model: finalModel,
        encryptedApiKey,
        embeddingProvider,
        embeddingBaseUrl: embeddingBaseUrl ?? baseUrl,
        embeddingModel,
        encryptedEmbeddingApiKey,
      },
    })

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'LLM_CONFIG_UPDATE',
      severity: 'warning',
      detail: {
        provider,
        baseUrl,
        model: finalModel,
        keyRotated: apiKey.length > 0,
        embeddingProvider,
        embeddingBaseUrl: embeddingBaseUrl ?? baseUrl,
        embeddingModel,
        embeddingKeyRotated: embeddingApiKey.length > 0,
      },
    })

    // Return the masked public view (single source of truth for shape/masking).
    const data = await getPublicLlmConfig(user.companyId)
    return NextResponse.json({ ok: true, data })
  } catch (e) {
    return handleApiError(e, 'Gagal menyimpan konfigurasi LLM.')
  }
}
