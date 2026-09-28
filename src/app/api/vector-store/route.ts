import { NextRequest, NextResponse } from 'next/server'
import { encryptConfig } from '@/lib/crypto'
import { db } from '@/lib/db'
import { ensureVectorCollection, getVectorStoreRuntimeConfig } from '@/lib/vector-stores'
import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'
import { maskSecret, normalizeBaseUrl } from '@/lib/llm-config'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { getVectorStorePreset } from '@/lib/db-provider-presets'
import { AppError } from '@/lib/errors'

/**
 * The ACTUAL embedding dimension and model present in the store.
 *
 * Read from `DocumentChunk` rather than from config, because config is what the operator ASKED for and this is what
 * the retriever will actually have to match. `null` when no chunk has an embedding yet (a fresh install), which the
 * UI renders as "unknown" rather than as a fabricated number.
 */
async function readStoredEmbeddingFacts(): Promise<{ size: number | null; model: string | null }> {
  const [row] = await db.$queryRaw<Array<{ dims: number | null; model: string | null }>>`
    SELECT vector_dims(embedding) AS dims, "embeddingModel" AS model
      FROM "DocumentChunk"
     WHERE embedding IS NOT NULL
     LIMIT 1
  `
  return { size: row?.dims ?? null, model: row?.model ?? null }
}

export async function GET() {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const row = await db.vectorStoreConfig.findFirst()
    // The MEASURED facts, so the response distinguishes "configured" from "actually stored".
    const stored = await readStoredEmbeddingFacts()
    return NextResponse.json({
      ok: true,
      data: row
        ? {
            provider: row.provider,
            baseUrl: row.baseUrl ?? '',
            apiKeyMasked: row.encryptedApiKey ? maskSecret('configured-key') : null,
            collectionName: row.collectionName,
            vectorSize: row.vectorSize,
            // The dimension the CHUNKS actually hold. When it differs from `vectorSize`, semantic scoring is
            // silently inert (see readStoredEmbeddingFacts) — so the UI can warn instead of showing a number that
            // describes the configured intent rather than the stored reality.
            storedVectorSize: stored.size,
            storedEmbeddingModel: stored.model,
            distance: row.distance,
            updatedAt: row.updatedAt.toISOString(),
          }
        : {
            provider: 'INTERNAL',
            baseUrl: '',
            apiKeyMasked: null,
            collectionName: 'ryasai_chunks',
            /*
             * MEASURED FROM THE DATA, never hardcoded.
             *
             * This reported a literal `1536` while the stored vectors were 384-dimensional. MEASURED IN UAT: the
             * LLM config asked for `text-embedding-3-small` (1536) while the chunks held
             * `paraphrase-multilingual-MiniLM-L12-v2` (384), and `retrieveRelevantChunks` requires
             * `chunk.embeddingModel === queryEmbedding.model` — so EVERY semantic score was 0 and retrieval
             * silently fell back to lexical only. The API reporting a configured number instead of the actual one
             * is what made that invisible: the operator sees "1536", the data is 384, and nothing says so.
             */
            /*
             * `vectorSize` is the CONFIGURED dimension — the form seeds from it, so it must keep the historical 1536
             * default rather than becoming null. The MEASURED values live in the two fields below, which is what makes
             * a mismatch visible instead of silent.
             */
            vectorSize: 1536,
            storedVectorSize: stored.size,
            storedEmbeddingModel: stored.model,
            distance: 'Cosine',
            updatedAt: null,
          },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load vector DB configuration.')
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
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
    const existing = await db.vectorStoreConfig.findFirst()

    // Fail-closed: an external backend without a base URL is a config that
    // cannot work — reject at save time instead of failing later at search
    // time with an opaque error. (The UI presets the URL per provider; this
    // also catches a stale URL from a provider switch the client missed.)
    const preset = getVectorStorePreset(provider)
    if (preset && preset.backend !== 'INTERNAL' && !baseUrl) {
      throw new AppError('VALIDATION_ERROR', `Base URL is required for ${preset.label}.`, {
        hint: `Example: ${preset.baseUrlPlaceholder}`,
      })
    }
    if (preset && preset.needsApiKey && !apiKey && !(existing && existing.encryptedApiKey)) {
      throw new AppError('VALIDATION_ERROR', `API key is required for ${preset.label}.`)
    }

    const payload = {
      provider,
      baseUrl,
      collectionName,
      vectorSize,
      distance,
      ...(apiKey ? { encryptedApiKey: encryptConfig({ apiKey }) } : {}),
    }

    if (existing) {
      await db.vectorStoreConfig.update({ where: { id: existing.id }, data: payload })
    } else {
      await db.vectorStoreConfig.create({
        data: {
          organizationId: user.organizationId,
          ...payload,
          encryptedApiKey: apiKey ? encryptConfig({ apiKey }) : undefined,
        },
      })
    }

    await writeAudit({
      userId: user.userId,
      action: 'VECTOR_STORE_CONFIG_UPDATE',
      severity: 'warning',
      detail: { provider, baseUrl, collectionName, vectorSize, distance, keyRotated: !!apiKey },
    })
    return GET()
  } catch (e) {
    return handleApiError(e, 'Failed to save vector DB configuration.')
  }
}

export async function POST() {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const config = await getVectorStoreRuntimeConfig()
    if (!config) return NextResponse.json({ ok: true, data: { provider: 'INTERNAL' } })
    await ensureVectorCollection(config)
    return NextResponse.json({ ok: true, data: { provider: config.provider, collectionName: config.collectionName } })
  } catch (e) {
    return handleApiError(e, 'Failed to test vector DB.', 502)
  }
}
