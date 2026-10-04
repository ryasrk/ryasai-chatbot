/**
 * Knowledge Graph — LightRAG-style entity-relation extraction + dual-level retrieval.
 *
 * Indexing: extract entities + relations from text chunks via LLM, store in DB.
 * Querying: local (entity-centric) + global (relation-chain) retrieval.
 *
 * ponytail: native TS implementation — no external cognee dependency for KG.
 * Falls back to empty results when LLM is unavailable (graceful degradation).
 */
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { getRoleLlmConfig, type LlmRuntimeConfig } from '@/lib/llm-config'
import { chatOnce } from '@/lib/llm-client'
import { scopedLogger } from '@/lib/logger'
import { getOrgContext } from '@/lib/prisma-tenant'
import { backgroundLockdownReason } from '@/lib/background-license'
import { tokenize } from '@/lib/rag'
import type { ChatHistoryEntry } from '@/lib/tool-utils'

const log = scopedLogger('kg')

// ---------------------------------------------------------------------------
// Schema types — entities + relations extracted from text chunks.
// ---------------------------------------------------------------------------

export interface ExtractedEntity {
  name: string
  type: string
  description: string
}

export interface ExtractedRelation {
  source: string
  target: string
  description: string
  keywords: string
}

export interface ExtractionResult {
  entities: ExtractedEntity[]
  relations: ExtractedRelation[]
}

// ---------------------------------------------------------------------------
// Entity-relation extraction prompt (LightRAG pattern).
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge graph extractor. Given a text chunk, extract entities and their relationships.

Return ONLY a JSON object with this structure:
{
  "entities": [{"name": "entity_name", "type": "person|organization|concept|event|location|other", "description": "brief description"}],
  "relations": [{"source": "entity_name", "target": "entity_name", "description": "relationship description", "keywords": "comma-separated keywords"}]
}

Rules:
- Extract only entities explicitly mentioned in the text
- Entity names should be canonical (lowercase, no articles)
- Relations must connect entities that both appear in the entities list
- Keep descriptions concise (1-2 sentences)
- If no entities found, return {"entities": [], "relations": []}`

// ---------------------------------------------------------------------------
// Indexing — extract entities + relations from a chunk, store in DB.
// Called during document ingestion (fire-and-forget after chunk save).
// ---------------------------------------------------------------------------

export async function extractEntitiesRelations(
  text: string,
  cfg: LlmRuntimeConfig,
): Promise<ExtractionResult> {
  if (text.trim().length < 50) return { entities: [], relations: [] }

  try {
    const raw = await chatOnce(
      cfg,
      [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: `Text chunk:\n${text.slice(0, 4000)}` },
      ],
      0,
      'kg-extract',
    )

    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned) as Partial<ExtractionResult>

    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities.filter(validEntity) : [],
      relations: Array.isArray(parsed.relations) ? parsed.relations.filter(validRelation) : [],
    }
  } catch (e) {
    log.warn('entity-relation extraction failed', { error: e instanceof Error ? e.message : String(e) })
    return { entities: [], relations: [] }
  }
}

function validEntity(e: unknown): e is ExtractedEntity {
  return typeof e === 'object' && e !== null &&
    typeof (e as ExtractedEntity).name === 'string' &&
    typeof (e as ExtractedEntity).type === 'string'
}

function validRelation(r: unknown): r is ExtractedRelation {
  return typeof r === 'object' && r !== null &&
    typeof (r as ExtractedRelation).source === 'string' &&
    typeof (r as ExtractedRelation).target === 'string'
}

// ---------------------------------------------------------------------------
// Indexing — store extracted entities + relations for a chunk.
// ponytail: uses DocumentChunk.keywords field to store entity names (CSV),
// and a new KgRelation table for relations. Falls back to no-op if table missing.
// ---------------------------------------------------------------------------

export async function indexChunkKnowledgeGraph(args: {
  chunkId: string
  content: string
}): Promise<void> {
  try {
    const orgId = getOrgContext()
    if (!orgId || await backgroundLockdownReason(orgId)) {
      log.warn('chunk graph indexing skipped: organization entitlement unavailable', { chunkId: args.chunkId })
      return
    }
    // Authorize before sending content to a provider or creating chunk relations.
    const existing = await db.documentChunk.findFirst({
      where: { id: args.chunkId }, select: { keywords: true },
    })
    if (!existing) return
    const cfg = await getRoleLlmConfig('extract')
    if (!cfg) return

    const extraction = await extractEntitiesRelations(args.content, cfg)
    if (extraction.entities.length === 0) return

    // Store entity names as keywords on the chunk (augments existing keyword extraction)
    const entityKeywords = extraction.entities.map((e) => e.name.toLowerCase()).join(',')
    if (entityKeywords) {
      // findFirst, NOT findUnique. `indexChunkKnowledgeGraph` is called from the ingest path with a chunk id, and
      // the write below APPENDS to `keywords`: an unscoped read-modify-write could carry another tenant's keyword
      // string into a row this tenant then reads, and would overwrite that row's keywords with a merged value.
      // As a FILTER op the extension appends the org, so a foreign chunk id resolves to null and the update is a
      // no-op for it.
      // Guarded: with the read now org-scoped, a null result means the chunk is not this tenant's (or is gone), and
      // updating it anyway would be the same unscoped write in a new costume.
      if (existing) {
        const merged = [existing.keywords ?? '', entityKeywords].filter(Boolean).join(',')
        await db.documentChunk.update({
          where: { id: args.chunkId },
          data: { keywords: merged },
        })
      }
    }

    // Store relations. KgRelation.organizationId is NOT NULL — omitting it made
    // every insert throw, and the old catch reported that as "table not available",
    // so the entire global/relation half of dual-level retrieval silently never
    // stored a row. Use the Prisma model so the tenant extension supplies the org.
    if (extraction.relations.length > 0) {
      const orgId = getOrgContext()
      if (!orgId) {
        log.warn('skipping KG relation storage — no org context', { chunkId: args.chunkId })
      } else {
        try {
          await db.kgRelation.createMany({
            data: extraction.relations.map((r) => ({
              id: randomUUID(),
              organizationId: orgId,
              chunkId: args.chunkId,
              source: r.source.toLowerCase().trim(),
              target: r.target.toLowerCase().trim(),
              description: r.description ?? '',
              keywords: r.keywords ?? '',
            })),
          })
        } catch (e) {
          // Loud: a failure here means the graph's global level goes stale, and
          // that is exactly the class of bug the old silent catch hid.
          log.warn('KG relation storage failed', {
            chunkId: args.chunkId,
            error: e instanceof Error ? e.message : String(e),
          })
          return
        }
      }
    }

    log.debug('Indexed chunk KG', {
      chunkId: args.chunkId,
      entities: extraction.entities.length,
      relations: extraction.relations.length,
    })
  } catch (e) {
    log.warn('indexChunkKnowledgeGraph failed', { error: e instanceof Error ? e.message : String(e) })
  }
}

// ---------------------------------------------------------------------------
// Dual-level retrieval — LightRAG's core algorithm.
// ---------------------------------------------------------------------------

export interface DualLevelResult {
  /** Local: chunks directly associated with matching entities */
  localChunks: string[]
  /** Global: chunks connected via relationship chains */
  globalChunks: string[]
  /** Combined unique chunk IDs (local + global, local first) */
  allChunkIds: string[]
  /** Entity names that matched the query */
  matchedEntities: string[]
  /** Graph context string for the LLM prompt */
  graphContext: string
}

// ponytail: cap the OR-list / ILIKE ANY array — a long question would otherwise
// build a where clause with one `contains` per token and scan the keyword index
// once per term. 8 covers real questions; raise it only if recall measurably drops.
const MAX_KG_QUERY_TOKENS = 8

/**
 * Trigram index for the KG entity scan, created at runtime like the `tsv` index in `rag-fts.ts`.
 *
 * WHY IT IS NOT A PRISMA `@@index`: Prisma cannot express an operator class (`gin_trgm_ops`), and `db push` runs in
 * `migrate` on EVERY boot — a Prisma-managed index Prisma cannot re-derive would read as drift and be dropped. The
 * runtime-DDL-plus-`IF NOT EXISTS` pattern is the one this codebase already uses for `DocumentChunk_tsv_idx`, for the
 * same reason, and Prisma leaves an index it did not create alone.
 *
 * WHY IT EXISTS AT ALL — MEASURED, because at today's size (131 rows) the query is instant and this looks like
 * premature work. `source ILIKE '%tok%'` cannot use a btree index (btree serves prefixes; `%tok%` is infix), so the
 * scan is proportional to row count:
 *
 *     rows      ILIKE seq-scan   with GIN trigram
 *     131       0.14 ms          —
 *     ~2 100    2 ms            —
 *     ~16 800   11 ms           —
 *     ~134 000  94 ms           9 ms
 *
 * The table doubles with every document uploaded, so this is the one KG cost that grows; the prompt does not
 * (`relations.slice(0, 10)` caps what reaches the answer regardless of table size).
 *
 * CONCURRENTLY, for the same reason as `ensureVectorIndexes`: a plain CREATE INDEX takes an ACCESS EXCLUSIVE lock and
 * an install booting with a large graph would stall its own queries. CONCURRENTLY cannot run inside a transaction, so
 * a failure falls back to a plain CREATE INDEX wrapped in a savepoint-free `catch {}` — the statement is idempotent
 * and a later boot retries; the query itself works either way, just slower until then.
 */
const KG_TRGM_DDL = new Set<string>()
let kgTrgmPromise: Promise<void> | null = null

export async function ensureKgTrgmIndexes(): Promise<void> {
  if (kgTrgmPromise) return kgTrgmPromise
  kgTrgmPromise = (async () => {
    // A test can disable the DDL to assert that the QUERY still works (slower) without the index — the property the
    // graceful failures below are meant to preserve. Not read anywhere in production code paths.
    if (process.env.KG_TRGM_DISABLED === '1') { KG_TRGM_DDL.add('disabled'); return }
    const provider = (await import('@/lib/db-provider')).getDbProvider()
    if (provider !== 'postgresql') {
      KG_TRGM_DDL.add('skip')
      return
    }
    try {
      await db.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`)
    } catch (e) {
      // The extension already exists or the role cannot create it (managed Postgres). The query still works
      // without the index — this only restores the old speed. Logged, not thrown, for that reason.
      log.warn('pg_trgm could not be ensured; the KG scan stays unindexed', { error: e instanceof Error ? e.message : String(e) })
      KG_TRGM_DDL.add('no-extension')
      return
    }
    try {
      // ONE INDEX PER COLUMN, not one combined GIN. MEASURED at 131k rows: a multicolumn GIN over
      // (source, target) was NEVER chosen for the OR-of-columns query below — Postgres can only probe the leading
      // column — and the plan stayed a sequential scan. Two single-column GINs are combined into a BitmapOr and
      // measured 0.054 ms against 502 ms without them, at 1.05M rows with a selective token.
      await db.$executeRawUnsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "KgRelation_source_trgm" ON "KgRelation" USING GIN (source gin_trgm_ops)`,
      )
      await db.$executeRawUnsafe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "KgRelation_target_trgm" ON "KgRelation" USING GIN (target gin_trgm_ops)`,
      )
      KG_TRGM_DDL.add('done')
    } catch {
      // CONCURRENTLY cannot run in a transaction. Retry the blocking form once; on a large table that is a slow
      // boot, but a correct one, and `IF NOT EXISTS` makes the next boot a no-op.
      try {
        await db.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS "KgRelation_source_trgm" ON "KgRelation" USING GIN (source gin_trgm_ops)`,
        )
        await db.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS "KgRelation_target_trgm" ON "KgRelation" USING GIN (target gin_trgm_ops)`,
        )
        KG_TRGM_DDL.add('done-blocking')
      } catch (e) {
        log.warn('KG trigram index could not be created; the scan stays unindexed', { error: e instanceof Error ? e.message : String(e) })
        KG_TRGM_DDL.add('failed')
      }
    }
  })()
  return kgTrgmPromise
}

/** Test hook: reset the once-per-process guard so a test can drive the DDL again. */
export function resetKgTrgmGuardForTests(): void {
  kgTrgmPromise = null
  KG_TRGM_DDL.clear()
}

export async function dualLevelRetrieval(args: {
  query: string
  topK?: number
}): Promise<DualLevelResult> {
  const topK = args.topK ?? 4
  // Use the shared tokenizer: the old `split(/\s+/).filter(len > 2)` kept
  // stopwords, so `queryTokens[0]` was usually "what"/"how" and the local level
  // matched — then 1.3x boosted — essentially random chunks.
  const queryTokens = tokenize(args.query).slice(0, MAX_KG_QUERY_TOKENS)

  const orgId = getOrgContext()
  if (queryTokens.length === 0 || !orgId) {
    return { localChunks: [], globalChunks: [], allChunkIds: [], matchedEntities: [], graphContext: '' }
  }

  try {
    // LOCAL: chunks whose keywords contain ANY query token (was: only the first).
    const localChunks = await db.documentChunk.findMany({ // nosemgrep — select is hardcoded, queryTokens is server-side tokenized string
      where: {
        document: { status: 'ready', isEnabled: true },
        OR: queryTokens.map((token) => ({ keywords: { contains: token } })),
      },
      take: topK * 3,
      select: { id: true, keywords: true },
    })

    // Match entities by checking if any query token appears in keywords
    const matchedEntities = new Set<string>()
    const localChunkIds: string[] = []
    for (const chunk of localChunks) {
      const kws = (chunk.keywords ?? '').toLowerCase().split(',')
      for (const kw of kws) {
        if (queryTokens.some((qt) => kw.includes(qt))) {
          matchedEntities.add(kw.trim())
          if (!localChunkIds.includes(chunk.id)) localChunkIds.push(chunk.id)
        }
      }
    }

    // GLOBAL: find chunks connected via relations to locally-matched entities
    let globalChunkIds: string[] = []
    let relationContext = ''
    try {
      // The trigram index this query needs, created before the first use. See `ensureKgTrgmIndexes`.
      await ensureKgTrgmIndexes()
      // Raw SQL bypasses the Prisma tenant extension, so organizationId has to be
      // filtered here explicitly — relationContext below is interpolated straight
      // into the answer prompt, so an unscoped row is a cross-tenant disclosure.
      /*
       * ONE ILIKE PER PATTERN, NOT `ILIKE ANY(array)`. The two are equivalent in RESULT and in cost as plain SQL,
       * but not to the planner: MEASURED at 1.05M rows, `ILIKE ANY` was never converted to an index scan (the
       * executor walks the array per row), while the expanded OR used the two GIN trigram indexes through a
       * BitmapOr. Without this expansion the indexes above would exist and do nothing — the exact "a defence
       * correct and TESTED while callers bypass it" shape.
       */
      const patterns = queryTokens.map((t) => `%${t}%`)
      const conds = Prisma.join(
        [...patterns, ...patterns].map((p, i) =>
          i < patterns.length ? Prisma.sql`r.source ILIKE ${p}` : Prisma.sql`r.target ILIKE ${p}`,
        ),
        ' OR ',
      )
      const relations = await db.$queryRaw<Array<{ chunkId: string; source: string; target: string; description: string }>>`
        SELECT r."chunkId", r.source, r.target, r.description
        FROM "KgRelation" r
        WHERE r."organizationId" = ${orgId}
          AND (${conds})
        LIMIT ${topK * 5}
      `
      globalChunkIds = [...new Set(relations.map((r) => r.chunkId))]
        .filter((id) => !localChunkIds.includes(id))
        .slice(0, topK * 2)

      if (relations.length > 0) {
        relationContext = relations
          .slice(0, 10)
          .map((r) => `[${r.source}] → ${r.description} → [${r.target}]`)
          .join('\n')
      }
    } catch (e) {
      // Degrade to local-only rather than failing the whole retrieval, but say why.
      log.warn('KG global retrieval failed, using local level only', {
        error: e instanceof Error ? e.message : String(e),
      })
    }

    const allChunkIds = [...localChunkIds, ...globalChunkIds]
    const graphContext = relationContext
      ? `Knowledge Graph Relations:\n${relationContext}`
      : ''

    return {
      localChunks: localChunkIds,
      globalChunks: globalChunkIds,
      allChunkIds,
      matchedEntities: [...matchedEntities],
      graphContext,
    }
  } catch (e) {
    log.warn('dualLevelRetrieval failed', { error: e instanceof Error ? e.message : String(e) })
    return { localChunks: [], globalChunks: [], allChunkIds: [], matchedEntities: [], graphContext: '' }
  }
}

// Re-export for consumers that need ChatHistoryEntry type
export type { ChatHistoryEntry }
