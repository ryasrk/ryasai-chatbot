/**
 * Entity-Hop retriever as a benchmark arm (docs/entity-hop-retrieval-plan.md, Phase 2).
 *
 * The plan says Entity-Hop is ONE MORE RANKING fed into the RRF that already exists, so the
 * legs are not re-implemented: `bm25Rank`, `fuseRankings`, `toRanking` and `tokenize` are the
 * production functions and `directRankings` reproduces the vector leg of
 * `benchmark/arms/hybrid-arm.ts`. A difference between this arm and that baseline is therefore
 * a difference in the hop step, not between two hand-rolled scorers.
 *
 * WHICH SEED A RUN USED — read before quoting a table. Both legs seed and both legs fuse when
 * `ctx.embeddings` and `ctx.queryEmbeddings` are present; otherwise the seed and the direct
 * legs are lexical-only, which is why `ready()` is true without vectors. `entityHopStats`
 * counts each call so a table can name its seed instead of implying one; a question with no
 * vector of its own degrades that ONE question and bumps `missingQueryVector` rather than
 * being absorbed silently. Deterministic: ties break on entity/docId ascending.
 */
import type { Arm, ArmContext, EntityHopAblation, EntityHopArmFactory } from '../arm-types'
import { ARM_BUDGET, ENTITY_HOP_DEFAULTS } from '../arm-types'
import { tokenize } from '@/lib/rag'
import { bm25Rank, fuseRankings, toRanking } from '@/lib/rag-ranking'

const ID_PATTERN = /\b[A-Z]{1,5}-\d{2,6}\b/g
const PT_PATTERN = /\bPT\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?/g
const BIGRAM_PATTERN = /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g
const NEGATION_PATTERN = /no record|not (?:attached|related|applicable)|does not apply|tidak ada|bukan/i
/** One appearance bridges nothing, so a bigram below this document frequency is not an entity. */
const MIN_BIGRAM_DF = 2

/**
 * Work bounds. One hub entity can name most documents, so an unbounded hop would fan out across
 * the whole corpus; traversal is in weighted order, so a cap drops the weakest bridges first.
 * The scan cap matters because a negation skip adds nothing while still consuming a scan.
 */
const MAX_FRONTIER_ENTITIES = 48
const MAX_DOCS_PER_HOP = 96
const MAX_DOC_SCANS_PER_HOP = 2000

/** One step of an evidence path: this document was reached through `viaEntity` from `fromDocId`. */
export interface HopPath {
  docId: string
  viaEntity: string | null
  fromDocId: string | null
  hop: number
}

/** Which seed recent calls used, so a reported table can name it instead of implying one. */
export const entityHopStats = { vectorSeeded: 0, lexicalSeeded: 0, missingQueryVector: 0 }

export interface EntityIndex {
  /** docId -> sorted, deduplicated entities in that document. */
  docEntities: Map<string, string[]>
  /** entity -> sorted docIds containing it, and the document frequency of each. */
  entityDocs: Map<string, string[]>
  df: Map<string, number>
  totalDocs: number
}

/** Ascending and locale-independent: RRF orders by score only, so every tie needs a fixed rule. */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Entities in one text: IDs, `PT ...` organisations, and Capitalised bigrams that cleared the
 * document-frequency gate. `bigramDf` is the corpus-wide df of bigram candidates; without it
 * no bigram is an entity, which is the right answer for text seen once.
 */
export function extractEntities(text: string, bigramDf?: Map<string, number>): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(ID_PATTERN)) found.add(match[0].toUpperCase())
  for (const match of text.matchAll(PT_PATTERN)) {
    found.add(`pt ${match[1]}${match[2] ? ` ${match[2]}` : ''}`.toLowerCase())
  }
  for (const match of text.matchAll(BIGRAM_PATTERN)) {
    const bigram = `${match[1]} ${match[2]}`.toLowerCase()
    if ((bigramDf?.get(bigram) ?? 0) < MIN_BIGRAM_DF) continue
    // Not a second entity when `PT Bumi Sentosa` is already one and this is its tail.
    if (![...found].some((name) => name.startsWith('pt ') && name.endsWith(` ${bigram}`))) found.add(bigram)
  }
  return [...found].sort(byId)
}

/** docId -> entities and entity -> docIds, plus document frequency. Pure, no I/O. */
export function buildEntityIndex(texts: Record<string, string>): EntityIndex {
  const docIds = Object.keys(texts).sort(byId)
  const bigramDf = new Map<string, number>()
  for (const docId of docIds) {
    const seen = new Set<string>()
    for (const match of (texts[docId] ?? '').matchAll(BIGRAM_PATTERN)) {
      seen.add(`${match[1]} ${match[2]}`.toLowerCase())
    }
    // Per-document dedup above: df counts DOCUMENTS, not occurrences.
    for (const bigram of seen) bigramDf.set(bigram, (bigramDf.get(bigram) ?? 0) + 1)
  }
  const docEntities = new Map<string, string[]>()
  const entityDocs = new Map<string, string[]>()
  for (const docId of docIds) {
    const entities = extractEntities(texts[docId] ?? '', bigramDf)
    docEntities.set(docId, entities)
    for (const entity of entities) {
      const docs = entityDocs.get(entity)
      if (docs) docs.push(docId)
      else entityDocs.set(entity, [docId])
    }
  }
  return {
    docEntities,
    entityDocs,
    df: new Map([...entityDocs].map(([entity, docs]) => [entity, docs.length])),
    totalDocs: docIds.length,
  }
}

/**
 * Does `text` carry a negation cue in the same sentence as `entity`? The plan's rule is that
 * one negated mention blocks the hop through that document for that entity.
 */
function negatedFor(text: string, entity: string): boolean {
  const needle = entity.toLowerCase()
  for (const sentence of text.toLowerCase().split(/[.!?;\n]+/)) {
    if (sentence.includes(needle) && NEGATION_PATTERN.test(sentence)) return true
  }
  return false
}

/**
 * The hop walk. `seedIds` were already retrieved by the direct legs, so they are marked seen and
 * never re-scored — which makes this step purely additive and keeps an empty hop ranking
 * byte-identical to the plain hybrid ranking (pinned by a test).
 */
function walkHops(
  index: EntityIndex,
  seedIds: string[],
  texts: Record<string, string>,
  questionEntities: Set<string>,
  opts: EntityHopAblation,
): { ranking: string[]; paths: HopPath[] } {
  const score = new Map<string, number>()
  const paths = new Map<string, HopPath>()
  const seenDocs = new Set(seedIds)
  // "minus everything already visited": question entities never seed a hop, and an entity
  // already used as a bridge is not used again at a later hop.
  const visitedEntities = new Set(questionEntities)
  const collect = (into: Map<string, string>, docId: string): void => {
    for (const entity of index.docEntities.get(docId) ?? []) {
      if (!visitedEntities.has(entity) && !into.has(entity)) into.set(entity, docId)
    }
  }

  let frontier = new Map<string, string>()
  for (const docId of seedIds) collect(frontier, docId)

  for (let hop = 1; hop <= opts.maxHops && frontier.size > 0; hop++) {
    for (const entity of frontier.keys()) visitedEntities.add(entity)
    const ordered = [...frontier.entries()]
      .map(([entity, fromDocId]) => ({
        entity,
        fromDocId,
        df: index.df.get(entity) ?? 0,
        // Rare entity = strong bridge. Flat 1.0 when the ablation turns the weight off.
        weight: opts.disableRarityWeight ? 1 : Math.log(index.totalDocs / Math.max(1, index.df.get(entity) ?? 1)),
      }))
      // Hub cutoff: an entity found in hundreds of documents is not a bridge.
      .filter(({ df }) => opts.disableHubCutoff || df <= opts.maxDocumentFrequency)
      .sort((a, b) => b.weight - a.weight || byId(a.entity, b.entity))
      .slice(0, MAX_FRONTIER_ENTITIES)

    const next = new Map<string, string>()
    let added = 0
    let scans = 0
    outer: for (const { entity, fromDocId, weight } of ordered) {
      for (const docId of index.entityDocs.get(entity) ?? []) {
        if (seenDocs.has(docId)) continue
        if (++scans > MAX_DOC_SCANS_PER_HOP) break outer
        if (!opts.disableNegation && negatedFor(texts[docId] ?? '', entity)) continue
        seenDocs.add(docId)
        score.set(docId, weight * Math.pow(opts.decay, hop - 1))
        paths.set(docId, { docId, viaEntity: entity, fromDocId, hop })
        collect(next, docId)
        if (++added >= MAX_DOCS_PER_HOP) break outer
      }
    }
    frontier = next
  }

  const ranking = [...score.entries()].sort((a, b) => b[1] - a[1] || byId(a[0], b[0])).map(([id]) => id)
  const orderedPaths = [...paths.values()].sort((a, b) => a.hop - b.hop || byId(a.docId, b.docId))
  return { ranking, paths: orderedPaths }
}

interface Prepared {
  index: EntityIndex
  /** BM25 documents in `ctx.docIds` order, so equal scores keep a reproducible order. */
  docs: Array<{ id: string; tokens: string[] }>
  /** Unit-normalised document vectors; empty when no cache is present. */
  vectors: Map<string, number[]>
}

// Keyed on the context object: one corpus per run, and rebuilding the tokenised index inside
// rank() would land in the timed region the plan budgets 50 ms for.
const preparedCache = new WeakMap<ArmContext, Prepared>()

function unit(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  return norm > 0 && Math.abs(norm - 1) > 1e-9 ? v.map((x) => x / norm) : v
}

function prepare(ctx: ArmContext): Prepared {
  const cached = preparedCache.get(ctx)
  if (cached) return cached
  const vectors = new Map<string, number[]>()
  for (const id of ctx.docIds) {
    const vector = ctx.embeddings?.[id]
    if (vector?.length) vectors.set(id, unit(vector))
  }
  const prepared: Prepared = {
    index: buildEntityIndex(ctx.texts),
    docs: ctx.docIds.map((id) => ({ id, tokens: tokenize(ctx.texts[id] ?? '') })),
    vectors,
  }
  preparedCache.set(ctx, prepared)
  return prepared
}

/**
 * Cosine top-k over the cached vectors, truncated exactly as `hybrid-arm.ts` truncates its leg
 * — a longer list would change the fused order that arm reports. Empty without a vector cache,
 * which is what makes the lexical-only path work. Stable sort, so ties keep corpus order.
 */
function directRankings(question: string, ctx: ArmContext, prepared: Prepared, budget: number) {
  const cached = prepared.vectors.size ? ctx.queryEmbeddings?.[question] ?? ctx.queryEmbeddings?.[question.trim()] : null
  // Counted, not absorbed: a table labelled "hybrid seed" whose questions partly ran
  // lexical-only would overstate how good the first hop was.
  if (prepared.vectors.size && !cached) entityHopStats.missingQueryVector += 1
  const query = cached ? unit(cached) : null
  const scored: Array<{ id: string; score: number }> = []
  if (query) {
    for (const { id } of prepared.docs) {
      const doc = prepared.vectors.get(id)
      if (!doc || doc.length !== query.length) continue
      let dot = 0
      for (let i = 0; i < doc.length; i++) dot += doc[i] * query[i]
      scored.push({ id, score: dot })
    }
    scored.sort((a, b) => b.score - a.score)
  }
  const vector = scored.slice(0, Math.max(budget * 8, 16)).map((entry) => entry.id)
  if (vector.length) entityHopStats.vectorSeeded += 1
  else entityHopStats.lexicalSeeded += 1
  return { vector, lexical: toRanking(bm25Rank(tokenize(question), prepared.docs)) }
}

/**
 * The arm id names the variant, because the ablation runner selects rows by id. Options are the
 * plan's ablations; an empty options object is the shipped arm, whose id the frozen contract
 * fixes at `entity-hop`. The seed is not an option — it follows what the context carries.
 */
function armIdFor(opts: Partial<EntityHopAblation>): string {
  if (opts.disableRarityWeight) return 'ablate-rarity-weight'
  if (opts.disableHubCutoff) return 'ablate-hub-cutoff'
  if (opts.disableNegation) return 'ablate-negation'
  if (opts.maxHops === 1) return 'hops-1'
  if (opts.maxHops === 3) return 'hops-3'
  return 'entity-hop'
}

/** The factory the ablation runner uses, so every variant is this same code path. */
export const makeEntityHopArm: EntityHopArmFactory = (opts: Partial<EntityHopAblation> = {}): Arm => {
  const options = { ...ENTITY_HOP_DEFAULTS, ...opts }
  const seedOf = (question: string, ctx: ArmContext, budget: number) => {
    const prepared = prepare(ctx)
    const direct = directRankings(question, ctx, prepared, budget)
    return { prepared, direct, seeds: toRanking(fuseRankings([direct.vector, direct.lexical])).slice(0, options.seedSize) }
  }
  return {
    id: armIdFor(opts),
    kind: 'entity-hop',
    // Lexical-only operation is supported on purpose: a corpus is enough.
    ready: (ctx) => ctx.docIds.length > 0,
    rank: (question, ctx, budget) => {
      const { prepared, direct, seeds } = seedOf(question, ctx, budget)
      const entities = new Set(extractEntities(question, prepared.index.df))
      const hop = walkHops(prepared.index, seeds, ctx.texts, entities, options)
      // Appended as one more retriever, so it cannot push out a strong direct hit — which is
      // what protects the easy tier.
      return toRanking(fuseRankings([direct.vector, direct.lexical, hop.ranking])).slice(0, budget)
    },
  }
}

export const arm: Arm = makeEntityHopArm()

/** Evidence trail for the hop step: one path per contributed document, in hop order. */
export function explainEntityHop(question: string, ctx: ArmContext, opts?: Partial<EntityHopAblation>): HopPath[] {
  const options = { ...ENTITY_HOP_DEFAULTS, ...opts }
  // The same seed `rank` uses at the harness's budget, so the trail explains the list that was
  // graded rather than a differently-truncated seed of it.
  const prepared = prepare(ctx)
  const direct = directRankings(question, ctx, prepared, ARM_BUDGET)
  const seeds = toRanking(fuseRankings([direct.vector, direct.lexical])).slice(0, options.seedSize)
  const entities = new Set(extractEntities(question, prepared.index.df))
  return walkHops(prepared.index, seeds, ctx.texts, entities, options).paths
}
