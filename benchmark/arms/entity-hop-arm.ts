/**
 * Entity-Hop retriever as a benchmark arm (docs/entity-hop-retrieval-plan.md, Phase 2).
 *
 * The plan calls Entity-Hop ONE MORE RANKING fed into the existing RRF, so the legs are not
 * re-implemented: `bm25Rank`, `lexicalFirst`, `toRanking` and the tokenizers are production functions and
 * `directRankings` reproduces the vector leg of `benchmark/arms/hybrid-arm.ts`.
 *
 * WHICH SEED A RUN USED — read before quoting a table. Both legs seed and fuse when `ctx.embeddings` and
 * `ctx.queryEmbeddings` are present; otherwise the seed and the direct legs are lexical-only, which is why
 * `ready()` is true without vectors. `entityHopStats` counts each call so a table can name its seed rather
 * than imply one, and a question with no vector of its own degrades that ONE question and bumps
 * `missingQueryVector` instead of passing silently. Ties break on entity/docId ascending.
 */
import type { Arm, ArmContext, EntityHopAblation, EntityHopArmFactory } from '../arm-types'
import { ARM_BUDGET, ENTITY_HOP_DEFAULTS } from '../arm-types'
import { tokenize, tokenizeForScoring } from '@/lib/rag'
import { bm25Rank, lexicalFirst, toRanking } from '@/lib/rag-ranking'

const ID_PATTERN = /\b[A-Z]{1,5}-\d{2,6}\b/g
const PT_PATTERN = /\bPT\s+([A-Z][a-z]+)(?:\s+([A-Z][a-z]+))?/g
const BIGRAM_PATTERN = /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g
const NEGATION_PATTERN = /no record|not (?:attached|related|applicable)|does not apply|tidak ada|bukan/i
const MIN_BIGRAM_DF = 2 // one appearance bridges nothing, so it is not worth storing
// One hub entity can name most documents, so an unbounded hop would fan across the whole corpus.
// Traversal is in weighted order, so a cap drops the weakest bridges first; scans are capped separately
// because a negation skip adds nothing while still consuming one.
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

/** Which seed recent calls used, so a reported table can name it rather than imply one. */
export const entityHopStats = { vectorSeeded: 0, lexicalSeeded: 0, missingQueryVector: 0 }

export interface EntityIndex {
  docEntities: Map<string, string[]> // docId -> sorted, deduplicated entities
  entityDocs: Map<string, string[]> // entity -> sorted docIds containing it
  df: Map<string, number> // entity -> its document frequency
  totalDocs: number
}

/** Ascending and locale-independent: RRF orders by score only, so every tie needs a fixed rule. */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// Entities in one text: IDs, `PT ...` organisations, and Capitalised bigrams that cleared the df gate.
// `bigramDf` is the corpus-wide df of bigram candidates; without it no bigram is an entity, which is the
// right answer for a text seen once.
export function extractEntities(text: string, bigramDf?: Map<string, number>): string[] {
  const found = new Set<string>()
  for (const m of text.matchAll(ID_PATTERN)) found.add(m[0].toUpperCase())
  for (const m of text.matchAll(PT_PATTERN)) found.add(`pt ${m[1]}${m[2] ? ` ${m[2]}` : ''}`.toLowerCase())
  for (const m of text.matchAll(BIGRAM_PATTERN)) {
    const bigram = `${m[1]} ${m[2]}`.toLowerCase()
    if ((bigramDf?.get(bigram) ?? 0) < MIN_BIGRAM_DF) continue
    // Not a second entity when `PT Bumi Sentosa` is already one and this bigram is its tail.
    if (![...found].some((n) => n.startsWith('pt ') && n.endsWith(` ${bigram}`))) found.add(bigram)
  }
  return [...found].sort(byId)
}

/** docId -> entities and entity -> docIds, plus document frequency. Pure, no I/O. */
export function buildEntityIndex(texts: Record<string, string>): EntityIndex {
  const docIds = Object.keys(texts).sort(byId)
  const bigramDf = new Map<string, number>()
  for (const docId of docIds) {
    const seen = new Set<string>() // per-document dedup: df counts DOCUMENTS, not occurrences
    for (const m of (texts[docId] ?? '').matchAll(BIGRAM_PATTERN)) seen.add(`${m[1]} ${m[2]}`.toLowerCase())
    for (const bigram of seen) bigramDf.set(bigram, (bigramDf.get(bigram) ?? 0) + 1)
  }
  const docEntities = new Map<string, string[]>()
  const entityDocs = new Map<string, string[]>()
  for (const docId of docIds) {
    const entities = extractEntities(texts[docId] ?? '', bigramDf)
    docEntities.set(docId, entities)
    for (const entity of entities) entityDocs.set(entity, [...(entityDocs.get(entity) ?? []), docId])
  }
  return {
    docEntities,
    entityDocs,
    df: new Map([...entityDocs].map(([entity, docs]) => [entity, docs.length])),
    totalDocs: docIds.length,
  }
}

/** Is there a negation cue in the same sentence as `entity`? One such mention blocks the hop. */
function negatedFor(text: string, entity: string): boolean {
  const needle = entity.toLowerCase()
  return text.toLowerCase()
    .split(/[.!?;\n]+/)
    .some((sentence) => sentence.includes(needle) && NEGATION_PATTERN.test(sentence))
}

// The hop walk. `seedIds` were already retrieved by the direct legs, so they are marked seen and never
// re-scored — which makes this step purely additive and keeps an empty hop ranking byte-identical to the
// plain hybrid ranking (pinned by a test).
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
  // "minus everything already visited": a question entity never seeds a hop; an entity already used as a
  // bridge is not reused at a later hop. `from` records the source document for the evidence trail.
  const visited = new Set(questionEntities)
  const collect = (into: Map<string, string>, docId: string): void => {
    for (const entity of index.docEntities.get(docId) ?? []) {
      if (!visited.has(entity) && !into.has(entity)) into.set(entity, docId)
    }
  }
  let frontier = new Map<string, string>()
  for (const docId of seedIds) collect(frontier, docId)

  for (let hop = 1; hop <= opts.maxHops && frontier.size > 0; hop++) {
    for (const entity of frontier.keys()) visited.add(entity)
    const ranked = [...frontier]
      .map(([entity, from]) => {
        const df = index.df.get(entity) ?? 0
        // Rare entity = strong bridge. Flat 1.0 when the ablation turns the weight off.
        const weight = opts.disableRarityWeight ? 1 : Math.log(index.totalDocs / Math.max(1, df))
        return { entity, from, df, weight }
      })
      // Hub cutoff: an entity found in hundreds of documents is not a bridge.
      .filter(({ df }) => opts.disableHubCutoff || df <= opts.maxDocumentFrequency)
      .sort((a, b) => b.weight - a.weight || byId(a.entity, b.entity))
      .slice(0, MAX_FRONTIER_ENTITIES)

    const next = new Map<string, string>()
    let added = 0
    let scans = 0
    outer: for (const { entity, from, weight } of ranked) {
      for (const docId of index.entityDocs.get(entity) ?? []) {
        if (seenDocs.has(docId)) continue
        if (++scans > MAX_DOC_SCANS_PER_HOP) break outer
        if (!opts.disableNegation && negatedFor(texts[docId] ?? '', entity)) continue
        seenDocs.add(docId)
        score.set(docId, weight * opts.decay ** (hop - 1))
        paths.set(docId, { docId, viaEntity: entity, fromDocId: from, hop })
        collect(next, docId)
        if (++added >= MAX_DOCS_PER_HOP) break outer
      }
    }
    frontier = next
  }
  const ordered = [...score].sort((a, b) => b[1] - a[1] || byId(a[0], b[0]))
  // Capped, because an uncapped tail is what breaks the easy tier: the walk returns 91-145 documents
  // here (p50 102, never zero) and RRF at k=60 discriminates rank only weakly (1/61 vs 1/200), so every
  // tail document collects credit and a hop doc at hop-rank 1 outbids a direct leg at leg-rank 9.
  // Truncating also keeps the empty-hop property below: with no hop documents the fusion is byte-identical
  // to the plain hybrid ranking, which is the safety net the easy-tier gate relies on.
  const ranking = ordered.slice(0, opts.maxHopDocs).map(([id]) => id)
  const kept = new Set(ranking)
  return {
    ranking,
    paths: [...paths.values()].filter((p) => kept.has(p.docId)).sort((a, b) => a.hop - b.hop || byId(a.docId, b.docId)),
  }
}

interface Prepared {
  index: EntityIndex
  docs: Array<{ id: string; tokens: string[] }> // BM25 docs, in ctx.docIds order for stable ties
  vectors: Map<string, number[]> // unit-normalised; empty when no vector cache is present
}

// Keyed on the context object: rebuilding the tokenised index inside rank() would land in the timed
// region the plan budgets 50 ms for.
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
    // The production scoring tokenizer, so the base this arm hops from is the base
    // production ships — otherwise the measured hop delta is against a ranking that no
    // longer exists (docs/retrieval-production-integration-plan.md §12).
    docs: ctx.docIds.map((id) => ({ id, tokens: tokenizeForScoring(ctx.texts[id] ?? '') })),
    vectors,
  }
  preparedCache.set(ctx, prepared)
  return prepared
}

// Both direct legs, unfused. Cosine top-k is truncated exactly as `hybrid-arm.ts` truncates its leg, or
// the fused order that arm reports would change. Empty without a cache: the lexical-only path.
function directRankings(question: string, ctx: ArmContext, prepared: Prepared, budget: number) {
  const cached = prepared.vectors.size ? ctx.queryEmbeddings?.[question] ?? ctx.queryEmbeddings?.[question.trim()] : null
  // Counted, not absorbed: a table labelled "hybrid seed" whose questions partly ran lexical-only would
  // overstate how good the first hop was.
  if (prepared.vectors.size && !cached) entityHopStats.missingQueryVector += 1
  const query = cached ? unit(cached) : null
  const scored: Array<{ id: string; score: number }> = []
  for (const { id } of query ? prepared.docs : []) {
    const doc = prepared.vectors.get(id)
    if (!doc || doc.length !== query!.length) continue
    let dot = 0
    for (let i = 0; i < doc.length; i++) dot += doc[i] * query![i]
    scored.push({ id, score: dot })
  }
  scored.sort((a, b) => b.score - a.score) // stable: equal scores keep `ctx.docIds` order
  const vector = scored.slice(0, Math.max(budget * 8, 16)).map((entry) => entry.id)
  if (vector.length) entityHopStats.vectorSeeded += 1
  else entityHopStats.lexicalSeeded += 1
  return { vector, lexical: toRanking(bm25Rank(tokenize(question), prepared.docs)) }
}

// The arm id names the variant, because the ablation runner selects its rows by id. An empty options
// object is the shipped arm, whose id the frozen contract fixes at `entity-hop`; the seed is not an
// option because it follows what the context carries.
function armIdFor(opts: Partial<EntityHopAblation>): string {
  if (opts.disableRarityWeight) return 'ablate-rarity-weight'
  if (opts.disableHubCutoff) return 'ablate-hub-cutoff'
  if (opts.disableNegation) return 'ablate-negation'
  if (opts.maxHopDocs !== undefined && opts.maxHopDocs > 100) return 'ablate-hop-doc-cap'
  return opts.maxHops === 1 ? 'hops-1' : opts.maxHops === 3 ? 'hops-3' : 'entity-hop'
}

/** The seed the arm and the trail both walk from, so the trail explains the list that was graded. */
function seedFor(question: string, ctx: ArmContext, budget: number, seedSize: number) {
  const prepared = prepare(ctx)
  const direct = directRankings(question, ctx, prepared, budget)
  return {
    prepared,
    direct,
    seeds: toRanking(lexicalFirst(direct.lexical, direct.vector)).slice(0, seedSize),
    entities: new Set(extractEntities(question, prepared.index.df)),
  }
}

/** The factory the ablation runner uses, so every variant is this same code path. */
export const makeEntityHopArm: EntityHopArmFactory = (opts: Partial<EntityHopAblation> = {}): Arm => {
  const options = { ...ENTITY_HOP_DEFAULTS, ...opts }
  return {
    id: armIdFor(opts),
    kind: 'entity-hop',
    ready: (ctx) => ctx.docIds.length > 0, // lexical-only is supported on purpose: a corpus is enough
    rank: (question, ctx, budget) => {
      const { prepared, direct, seeds, entities } = seedFor(question, ctx, budget, options.seedSize)
      const hop = walkHops(prepared.index, seeds, ctx.texts, entities, options)
      // Appended after the direct ranking, so it cannot push out a strong direct hit — the
      // same guarantee `lexicalFirst` gives the vector leg, and what protects the easy tier.
      return toRanking(lexicalFirst(direct.lexical, [...direct.vector, ...hop.ranking])).slice(0, budget)
    },
  }
}

export const arm: Arm = makeEntityHopArm()

/** Evidence trail for the hop step: one path per contributed document, in hop order. */
export function explainEntityHop(question: string, ctx: ArmContext, opts?: Partial<EntityHopAblation>): HopPath[] {
  const options = { ...ENTITY_HOP_DEFAULTS, ...opts }
  // Same budget as `rank(..., ARM_BUDGET)`, so the trail explains the list the harness graded.
  const { prepared, seeds, entities } = seedFor(question, ctx, ARM_BUDGET, options.seedSize)
  return walkHops(prepared.index, seeds, ctx.texts, entities, options).paths
}
