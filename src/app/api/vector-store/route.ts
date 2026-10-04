import { NextRequest, NextResponse } from 'next/server'
import { encryptConfig } from '@/lib/crypto'
import { db } from '@/lib/db'
import { ensureVectorCollection, getVectorStoreRuntimeConfig } from '@/lib/vector-stores'
import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'
import { maskSecret, normalizeBaseUrl, resolveConfiguredEmbeddingModel } from '@/lib/llm-config'
import { compareEmbeddingStamps } from '@/lib/embedding-stamp'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { getVectorStorePreset } from '@/lib/db-provider-presets'
import { AppError } from '@/lib/errors'
import { EMBEDDING_DIMENSIONS } from '@/lib/constants'

/**
 * The ACTUAL embedding dimension and model present in the store.
 *
 * Read from `DocumentChunk` rather than from config, because config is what the operator ASKED for and this is what
 * the retriever will actually have to match. `null` when no chunk has an embedding yet (a fresh install), which the
 * UI renders as "unknown" rather than as a fabricated number.
 */
async function readStoredEmbeddingFacts(organizationId: string): Promise<{ size: number | null; model: string | null }> {
  const [row] = await db.$queryRaw<Array<{ dims: number | null; model: string | null }>>`
    SELECT vector_dims(embedding) AS dims, "embeddingModel" AS model
      FROM "DocumentChunk"
     WHERE "organizationId" = ${organizationId} AND embedding IS NOT NULL
     LIMIT 1
  `
  return { size: row?.dims ?? null, model: row?.model ?? null }
}

export async function GET() {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    const row = await db.vectorStoreConfig.findFirst()
    // The MEASURED facts, so the response distinguishes "configured" from "actually stored".
    const stored = await readStoredEmbeddingFacts(user.organizationId)
    /*
     * The two halves of the comparison the UI needs and previously could not make.
     *
     * The response already carried the MODEL stored on the chunks (`storedEmbeddingModel`), but not the model the
     * config would embed a QUERY with — so the panel could print the stored model as an aside and never notice it
     * disagreed. `retrieveRelevantChunks` decides `embeddingUsable` with
     * `chunk.embeddingModel === queryEmbedding.model`: WHEN THEY DIFFER, every chunk is skipped, every semantic
     * score is 0, and search silently degrades to lexical-only. The dimension fields above catch the loudest form of
     * that (384 vs 1536); this catches the quiet one — two models of the SAME width.
     *
     * The verdict is computed HERE, from the same two values the response carries, rather than left to each client:
     * one authoritative comparison, and the strictness lives in one place (`compareEmbeddingStamps` compares exact
     * strings, because that is what the retriever does — see that module for why no prefix normalisation is used).
     *
     * `configuredEmbeddingModel` is null when there is no config row or no org context, and the verdict is then
     * 'unknown' rather than 'match': "nothing was compared" must never render as "verified fine".
     */
    const configuredEmbeddingModel = await resolveConfiguredEmbeddingModel()
    const embeddingStampVerdict = compareEmbeddingStamps(stored.model, configuredEmbeddingModel)
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
            configuredEmbeddingModel,
            embeddingStampVerdict,
            distance: row.distance,
            // Whether an admin ever SAVED a storage choice. The provider column above defaults to INTERNAL, so
            // before this flag is true that value means "nobody has chosen", not "internal was chosen" — the
            // Knowledge view renders the two cases differently and the upload route refuses documents until this
            // is true.
            storageChosen: Boolean(row.storageChosenAt),
            storageChosenAt: row.storageChosenAt?.toISOString() ?? null,
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
             *
             * So the CONFIGURED dimension below is seeded from `EMBEDDING_DIMENSIONS` (the one fact about the
             * bundled embedder) rather than from a literal, and the two MEASURED fields beside it are what make a
             * mismatch visible instead of silent. An earlier version of this comment claimed the value had to stay
             * at the historical `1536`; that literal WAS the bug it was describing.
             */
            vectorSize: EMBEDDING_DIMENSIONS,
            storedVectorSize: stored.size,
            storedEmbeddingModel: stored.model,
            configuredEmbeddingModel,
            embeddingStampVerdict,
            distance: 'Cosine',
            /* No row at all: nothing has ever been saved for this org, so the choice is not merely unset — it
             * cannot have been made. Reported explicitly so the UI never has to infer it from `updatedAt`. */
            storageChosen: false,
            storageChosenAt: null,
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
    const vectorSize = Math.max(1, Number(body.vectorSize ?? EMBEDDING_DIMENSIONS) || EMBEDDING_DIMENSIONS)
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
      /*
       * A successful save of this row IS the choice of where the knowledge base is stored — there is no separate
       * "confirm" step to forget, and no way to reach this route without having decided between Internal and an
       * external store (`INTERNAL` with an empty base URL is a valid, deliberate answer). Recording it here rather
       * than in the UI keeps the API honest for the wizard and for any script.
       *
       * The timestamp is STICKY: `existing.storageChosenAt` wins, so re-saving settings answers "has a choice been
       * made", not "when was the form last touched". `updatedAt` already carries the latter, and overwriting this
       * one would quietly rewrite the answer to "when did this install decide" on every unrelated edit.
       */
      storageChosenAt: existing?.storageChosenAt ?? new Date(),
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
      detail: {
        provider,
        baseUrl,
        collectionName,
        vectorSize,
        distance,
        keyRotated: !!apiKey,
        // Whether this save is the one that UNBLOCKED knowledge upload. An operator reading the audit trail later
        // needs to tell "first choice" from "settings tweak", and before this the trail could not say.
        storageChoiceMade: !existing?.storageChosenAt,
      },
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
