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
import { db } from '@/lib/db'
import { getRoleLlmConfig, type LlmRuntimeConfig } from '@/lib/llm-config'
import { chatOnce } from '@/lib/llm-client'
import { scopedLogger } from '@/lib/logger'
import { getOrgContext } from '@/lib/prisma-tenant'
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
    const cfg = await getRoleLlmConfig('extract')
    if (!cfg) return

    const extraction = await extractEntitiesRelations(args.content, cfg)
    if (extraction.entities.length === 0) return

    // Store entity names as keywords on the chunk (augments existing keyword extraction)
    const entityKeywords = extraction.entities.map((e) => e.name.toLowerCase()).join(',')
    if (entityKeywords) {
      const existing = await db.documentChunk.findUnique({
        where: { id: args.chunkId },
        select: { keywords: true },
      })
      const merged = [existing?.keywords ?? '', entityKeywords].filter(Boolean).join(',')
      await db.documentChunk.update({
        where: { id: args.chunkId },
        data: { keywords: merged },
      })
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
      // Raw SQL bypasses the Prisma tenant extension, so organizationId has to be
      // filtered here explicitly — relationContext below is interpolated straight
      // into the answer prompt, so an unscoped row is a cross-tenant disclosure.
      const patterns = queryTokens.map((t) => `%${t}%`)
      const relations = await db.$queryRaw<Array<{ chunkId: string; source: string; target: string; description: string }>>`
        SELECT r."chunkId", r.source, r.target, r.description
        FROM "KgRelation" r
        WHERE r."organizationId" = ${orgId}
          AND (r.source ILIKE ANY(${patterns}::text[])
            OR r.target ILIKE ANY(${patterns}::text[]))
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
