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
    await getActiveUser()
    const data = await getPublicLlmConfig()
    return NextResponse.json({ ok: true, data })
  } catch (e) {
    return handleApiError(e, 'Failed to load LLM configuration.')
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

    const body = (await req.json().catch(() => ({}))) as PutBody
    const VALID_PROVIDERS = new Set(['OPENAI_COMPATIBLE', 'ANTHROPIC_COMPATIBLE'])
    const provider = VALID_PROVIDERS.has((body.provider ?? '').trim().toUpperCase())
      ? (body.provider as string).trim().toUpperCase()
      : 'OPENAI_COMPATIBLE'
    const model = (body.model ?? '').trim()
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
    const embeddingProvider = VALID_PROVIDERS.has((body.embeddingProvider ?? '').trim().toUpperCase())
      ? (body.embeddingProvider as string).trim().toUpperCase()
      : 'OPENAI_COMPATIBLE'
    const embeddingModel = (body.embeddingModel ?? '').trim() || 'text-embedding-3-small'
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
        { ok: false, error: e instanceof Error ? e.message : 'Base URL is invalid.' },
        { status: 400 },
      )
    }

    const existing = await db.llmConfig.findFirst()

    // apiKey is required on first create; on update, a blank value keeps the existing key.
    if (!apiKey && !existing) {
      return NextResponse.json(
        { ok: false, error: 'API key is required on first configuration.' },
        { status: 400 },
      )
    }

    const finalModel = model || existing?.model || ''
    const encryptedApiKey = apiKey
      ? encryptConfig({ apiKey })
      : existing!.encryptedApiKey
    // Auto-copy LLM apiKey to embedding if no separate embedding key provided
    const effectiveEmbeddingApiKey = embeddingApiKey || apiKey
    const encryptedEmbeddingApiKey = effectiveEmbeddingApiKey
      ? encryptConfig({ apiKey: effectiveEmbeddingApiKey })
      : existing?.encryptedEmbeddingApiKey ?? encryptedApiKey

    const payload = {
      provider,
      baseUrl,
      model: finalModel,
      ...(apiKey ? { encryptedApiKey } : {}),
      embeddingProvider,
      embeddingBaseUrl: embeddingBaseUrl ?? baseUrl,
      embeddingModel,
      ...(effectiveEmbeddingApiKey ? { encryptedEmbeddingApiKey } : {}),
    }

    if (existing) {
      await db.llmConfig.update({ where: { id: existing.id }, data: payload })
    } else {
      await db.llmConfig.create({
        data: { ...payload, encryptedApiKey, encryptedEmbeddingApiKey },
      })
    }

    await writeAudit({
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
    const data = await getPublicLlmConfig()
    return NextResponse.json({ ok: true, data })
  } catch (e) {
    return handleApiError(e, 'Failed to save LLM configuration.')
  }
}
