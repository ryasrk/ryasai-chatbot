/**
 * LLM model discovery — fetch available models from {baseUrl}/models.
 * ----------------------------------------------------------------------------
 * POST /api/llm-config/models
 *   body: { baseUrl?, apiKey? }
 *
 * Uses the provided baseUrl/apiKey, falling back to the stored encrypted key.
 * Caches the result into LlmConfig.availableModels + lastModelSyncAt.
 * Admin-only (rotates nothing, but reveals connectivity to the provider).
 */
import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import {
  fetchProviderModels,
  getLlmRuntimeConfig,
  normalizeBaseUrl,
} from '@/lib/llm-config'
import { encryptConfig } from '@/lib/crypto'
import { db } from '@/lib/db'

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()

    const body = (await req.json().catch(() => ({}))) as {
      baseUrl?: string
      apiKey?: string
    }

    // Resolve baseUrl: provided > stored.
    const stored = await getLlmRuntimeConfig()
    let baseUrl: string
    try {
      baseUrl = normalizeBaseUrl(body.baseUrl ?? stored?.baseUrl ?? '')
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: e instanceof Error ? e.message : 'Base URL is invalid.' },
        { status: 400 },
      )
    }

    // Resolve apiKey: provided plaintext > stored decrypted.
    let apiKey = (typeof body.apiKey === 'string' ? body.apiKey.trim() : '')
    if (!apiKey && stored) {
      try {
        apiKey = stored.apiKey
      } catch {
        /* fall through */
      }
    }
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: 'API key is required to fetch the model list.' },
        { status: 400 },
      )
    }

    const models = await fetchProviderModels({ baseUrl, apiKey })

    // Cache into the config row if one exists; create a stub otherwise.
    const existing = await db.llmConfig.findFirst()
    if (existing) {
      await db.llmConfig.update({
        where: { id: existing.id },
        data: {
          availableModels: JSON.stringify(models),
          lastModelSyncAt: new Date(),
        },
      })
    } else {
      await db.llmConfig.create({
        data: {
          organizationId: user.organizationId,
          purpose: 'chat',
          provider: 'OPENAI_COMPATIBLE',
          baseUrl,
          model: models[0] ?? '',
          encryptedApiKey: encryptConfig({ apiKey }),
          availableModels: JSON.stringify(models),
          lastModelSyncAt: new Date(),
        },
      })
    }

    await writeAudit({
      userId: user.userId,
      action: 'LLM_MODELS_SYNC',
      severity: 'info',
      detail: { baseUrl, count: models.length },
    })

    return NextResponse.json({ ok: true, data: { models, count: models.length } })
  } catch (e) {
    return handleApiError(e, 'Failed to fetch model list.', 502)
  }
}
