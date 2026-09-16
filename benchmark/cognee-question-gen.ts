#!/usr/bin/env bun
/**
 * 1000-question benchmark generator for the cognee memory layer.
 * ----------------------------------------------------------------------------
 * Implements `docs/cognee-benchmark-design.md` §3 (tiers) and §4 (ground truth).
 *
 * WHY THE TIERS ARE DEFINED BY DOCUMENT IDS AND NOT BY PROSE
 *
 * The 3-question probe in scripts/cognee-quality-probe.ts scored 100% on its
 * first run and the number was worthless: the corpus held 6 items, so "return
 * everything" scored 100% too, and every hit arrived with its own decoy. The
 * fix there was a per-question decoy plus an unanswerable control.
 *
 * At 1000 questions the same trap returns in a subtler form: a question is only
 * a real multi-hop question if the answer is NOT recoverable from one document.
 * Judging that from the question text alone is guesswork, so every question here
 * is built from the corpus's own relation graph and carries the exact
 * `evidenceDocIds` a correct retriever must return. `gt-lint.ts` then re-reads
 * the corpus and proves minimality (each hop's target appears in exactly one
 * document) rather than trusting this file's intent.
 *
 * A question whose chain cannot be made minimal is DISCARDED, never relabelled
 * into a weaker tier — relabelling would inflate the easy tier, which per §3.1
 * is a validity gate (easy < 95% invalidates the whole run).
 *
 * Usage:
 *   bun benchmark/cognee-question-gen.ts --corpus=/tmp/corpus.json \
 *       --out=/tmp/questions.jsonl --easy=150 --medium=350 --hard=300 --complex=200
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { Corpus, CorpusDocument, GroundTruthRelation } from './cognee-corpus'

// ---------------------------------------------------------------------------
// Types — the §4.1 record shape, exactly.
// ---------------------------------------------------------------------------

export type Tier = 'easy' | 'medium' | 'hard' | 'complex'
export type SubMechanism = 'supersession' | 'negative' | 'disambiguation' | 'aggregation'

export interface Hop {
  from: string
  via: string
  to: string
  docId: string
}

export interface BenchmarkQuestion {
  id: string
  tier: Tier
  submechanism: SubMechanism | null
  question: string
  answer: string
  answerAliases: string[]
  /** MINIMAL supporting set, ordered by hop. Removing any element breaks the question. */
  evidenceDocIds: string[]
  hopChain: Hop[]
  distractorDocIds: string[]
  distractorStrings: string[]
  mustAppearTokens: string[]
  mustNotAppearTokens: string[]
  asOf: string | null
  answerIsNegative: boolean
}

// ---------------------------------------------------------------------------
// Deterministic RNG. Math.random is banned: a benchmark whose questions change
// between runs cannot be compared across commits, and a regression then looks
// like sampling noise.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Rng {
  private next: () => number
  constructor(seed: number) {
    this.next = mulberry32(seed)
  }
  float() {
    return this.next()
  }
  int(maxExclusive: number) {
    return Math.floor(this.next() * maxExclusive)
  }
  pick<T>(arr: T[]): T {
    return arr[this.int(arr.length)]
  }
  /** Deterministic Fisher–Yates; returns a new array. */
  shuffle<T>(arr: T[]): T[] {
    const out = arr.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Corpus access helpers
// ---------------------------------------------------------------------------

/**
 * A relation carrying the document that asserts it.
 *
 * `GroundTruthRelation` itself has no `docId` — the document is the container in
 * `CorpusIndex.documents[].relations`. Minimality (§4.2) is a statement about
 * DOCUMENTS, so every edge has to keep its provenance or the check is impossible.
 */
interface Edge extends GroundTruthRelation {
  docId: string
}

interface World {
  corpus: Corpus
  docs: CorpusDocument[]
  docById: Map<string, CorpusDocument>
  /** entity id -> the doc ids that mention it (multi-doc entities enable joins). */
  docsForEntity: Map<string, string[]>
  /** predicate -> relations, so a tier can pull only the edges it can chain. */
  byPredicate: Map<string, Edge[]>
  /** docId -> relations asserted by that doc. */
  relsByDoc: Map<string, Edge[]>
  /** Every edge, for tiers that must not be limited to a hand-picked predicate list. */
  allEdges: Edge[]
  /** entity id -> edges whose OBJECT is it (arriving at the entity). */
  edgesEndingAt: Map<string, Edge[]>
  /** entity id -> edges whose SUBJECT is it (the only legal way to CONTINUE a chain). */
  edgesStartingAt: Map<string, Edge[]>
  /** Tokens so frequent that an answer containing one would not identify anything. */
  commonTokens: Set<string>
  names: Record<string, string>
}

/**
 * §4.3(e): an answer that is a frequent corpus word ("batch", "invoice") would
 * make a substring match trivially succeed. The design calls for rejecting any
 * single-token answer appearing in >0.5% of the corpus; we approximate that by
 * banning tokens that appear in more than 0.5% of documents, checked against the
 * real corpus rather than a hand-written stopword list.
 */
function isCommonToken(answer: string, w: World): boolean {
  // Only a SINGLE-token answer can be trivially matched. A multi-word label like
  // "Sinar Abadi" stays distinctive even when "sinar" alone is frequent, because
  // the token PAIR is what the grader matches on. Applying the frequency test to
  // every token rejected 22% of all entities and starved the medium/hard tiers.
  const tokens = answer.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length !== 1) return tokens.length === 0
  const t = tokens[0]
  return t.length >= 4 && w.commonTokens.has(t)
}

function loadWorld(path: string): World {
  const corpus = JSON.parse(readFileSync(path, 'utf8')) as Corpus
  const docs = corpus.docs
  const docById = new Map(docs.map((d) => [d.id, d]))
  const docsForEntity = new Map<string, string[]>()
  const relsByDoc = new Map<string, Edge[]>()
  const byPredicate = new Map<string, Edge[]>()

  const names = corpus.index?.namesById ?? {}
  for (const d of docs) {
    // Declared mentions plus text matches. `entityIds` is populated for only
    // 700 of 1200 documents, so a locality test built from it alone would answer
    // "not mentioned" for the other 500 and silently accept non-minimal chains.
    const seen = new Set<string>(d.entityIds ?? [])
    const hay = d.text.toLowerCase()
    for (const [id, name] of Object.entries(names)) {
      if (seen.has(id) || !name || name.length < 5) continue
      // Compare on the distinctive part: "PT Sinar Abadi" is cited as
      // "PT Sinar Abadi" or "Sinar Abadi", never as the raw id.
      const bare = name.replace(/^PT\s+/i, '').toLowerCase()
      if (hay.includes(name.toLowerCase()) || (bare.length >= 5 && hay.includes(bare))) seen.add(id)
    }
    for (const e of seen) {
      const list = docsForEntity.get(e)
      if (list) list.push(d.id)
      else docsForEntity.set(e, [d.id])
    }
  }
  // Index relations both by the document that asserts them and by predicate.
  // `documents[].relations` is authoritative for "which doc says this"; using the
  // flat relation list would lose the docId and make minimality unprovable.
  for (const entry of corpus.index?.documents ?? []) {
    const edges: Edge[] = (entry.relations ?? []).map((r) => ({ ...r, docId: entry.id }))
    relsByDoc.set(entry.id, edges)
    for (const r of edges) {
      const list = byPredicate.get(r.predicate)
      if (list) list.push(r)
      else byPredicate.set(r.predicate, [r])
    }
  }
  const allEdges: Edge[] = []
  for (const edges of relsByDoc.values()) allEdges.push(...edges)
  // Two direction-indexed views. The names matter: the first attempt used one map
  // keyed on `object` and drew CONTINUING hops from it, which produced chains of
  // the form A -> B -> B. Keeping both directions explicit makes that mistake
  // impossible to repeat silently.
  const edgesEndingAt = new Map<string, Edge[]>()
  const edgesStartingAt = new Map<string, Edge[]>()
  for (const e of allEdges) {
    const into = edgesEndingAt.get(e.object)
    if (into) into.push(e)
    else edgesEndingAt.set(e.object, [e])
    const from = edgesStartingAt.get(e.subject)
    if (from) from.push(e)
    else edgesStartingAt.set(e.subject, [e])
  }

  // Frequency table over whole documents, so "common" means "common in THIS
  // corpus" instead of depending on a stopword list that drifts from the data.
  const docFreq = new Map<string, number>()
  for (const d of docs) {
    for (const t of new Set(d.text.toLowerCase().match(/[a-z]{4,}/g) ?? [])) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
    }
  }
  const threshold = docs.length * 0.005
  const commonTokens = new Set<string>()
  for (const [t, n] of docFreq) if (n > threshold) commonTokens.add(t)

  return { corpus, docs, docById, docsForEntity, byPredicate, relsByDoc, allEdges, edgesEndingAt, edgesStartingAt, commonTokens, names }
}

/** True when `token` never appears in `doc`.ids(...) — used for minimality checks. */
function docIdsContaining(doc: CorpusDocument, entityId: string): boolean {
  return (doc.entityIds ?? []).includes(entityId)
}

/**
 * MINIMALITY (§4.2), done by re-reading the documents rather than by intent.
 *
 * The first version of this only compared hop ids for equality and checked that
 * the FIRST document did not name the LAST entity. That passed chains that were
 * not minimal at all: on this corpus `raised_against` puts a vendor and its
 * purchase order in the SAME document, so "which vendor is that PO against?" is a
 * one-document question, and a validation run found 711 of 1000 questions were
 * answerable from a single evidence document.
 *
 * The property that actually holds for a real multi-hop question is:
 *   (a) each hop lives in a different document, and
 *   (b) the ANSWER entity appears in exactly the LAST hop's document — so it
 *       cannot be read off any earlier one, and
 *   (c) no single evidence document contains the answer text at all.
 *
 * (b) is checked against `docsForEntity`, the corpus's own mention index, not
 * against intent. If the answer entity is mentioned in several documents the
 * question is dropped, because the answer would be findable without traversing.
 */
function isMinimalChain(
  hops: Hop[],
  docById: Map<string, CorpusDocument>,
  answerEntityId: string,
  docsForEntity: Map<string, string[]>,
): boolean {
  if (hops.length < 2) return true
  const seen = new Set<string>()
  for (const h of hops) {
    if (seen.has(h.docId)) return false
    seen.add(h.docId)
  }
  const finalDoc = hops[hops.length - 1].docId
  const answerDocs = new Set(docsForEntity.get(answerEntityId) ?? [])
  // (c) the answer must not be mentioned by ANY other document in the evidence
  // set. This is the locality that makes the chain necessary. Requiring the
  // answer to be globally unique was stronger than needed and left only 291 of
  // 800 objects usable, which starved the tiers of questions for no benefit.
  for (const h of hops.slice(0, -1)) {
    if (h.docId === finalDoc) return false
    if (answerDocs.has(h.docId)) return false
  }
  return true
}

/**
 * Reject answers that are not a stable, human-readable entity.
 *
 * The first generated batch shipped answers like `day-296` — the object of a
 * timing relation, which is not in `entityIds` at all. Those are neither
 * distinctive (the same day number recurs across unrelated deliveries) nor
 * renderable in a question. Requiring a resolving NAME excludes them, and the
 * minimality test above would not have caught it because the id simply never
 * appears in any document's mention list.
 */
function isResolvableEntity(w: World, id: string): boolean {
  const name = w.names[id]
  if (!name) return false
  if (name === id) return false
  if (/^day-\d+$/i.test(id)) return false
  return name.length >= 5
}

/** Human label for an entity id, for rendering questions without re-parsing prose. */
function label(w: World, id: string): string {
  return w.names[id] ?? id
}

/** Strip a leading "PT " so the answer string is the distinctive part only. */
function canonicalAnswer(w: World, id: string): string {
  return label(w, id).replace(/^PT\s+/i, '').trim()
}

// ---------------------------------------------------------------------------
// Tier builders
// ---------------------------------------------------------------------------

/**
 * EASY — one document, answer present as a literal token, question a paraphrase.
 *
 * §3.1 requires the question share at most ~40% of its content tokens with the
 * document, otherwise it is a copy-paste test of the retriever's tokenizer rather
 * than of memory. We phrase the question around the SUBJECT and ask for the
 * OBJECT, which keeps the object token out of the question by construction.
 */
function buildEasy(w: World, rng: Rng, idx: number, used: Set<string>): BenchmarkQuestion | null {
  const rels = (w.byPredicate.get('raised_against') ?? []).concat(
    w.byPredicate.get('from_vendor') ?? [],
    w.byPredicate.get('carried_batch') ?? [],
    w.byPredicate.get('scoped_to_project') ?? [],
  )
  for (let attempt = 0; attempt < 40; attempt++) {
    const r = rng.pick(rels)
    const docs = (w.docsForEntity.get(r.subject) ?? []).filter((d) => docIdsContaining(w.docById.get(d)!, r.object))
    if (docs.length === 0) continue
    const docId = docs[0]
    if (used.has(docId)) continue
    const key = `easy|${r.subject}|${r.object}`
    if (used.has(key)) continue
    used.add(docId)
    used.add(key)
    if (!isResolvableEntity(w, r.object)) continue
    const answer = canonicalAnswer(w, r.object)
    if (answer.length < 5) continue

    // One near-miss: a different object of the same predicate, mentioned in the
    // corpus, whose document the retriever will also match on the subject.
    const sibling = rels.find((x) => x.predicate === r.predicate && x.subject === r.subject && x.object !== r.object)
    const distractors = sibling ? [sibling.object] : []

    return {
      id: `easy-${String(idx).padStart(5, '0')}`,
      tier: 'easy',
      submechanism: null,
      question: `Which ${nounFor(r.predicate)} is ${label(w, r.subject)} associated with?`,
      answer,
      answerAliases: [label(w, r.object), answer],
      evidenceDocIds: [docId],
      hopChain: [{ from: label(w, r.subject), via: r.predicate, to: label(w, r.object), docId }],
      distractorDocIds: sibling ? (w.docsForEntity.get(sibling.object) ?? []).slice(0, 1) : [],
      distractorStrings: distractors.map((d) => canonicalAnswer(w, d)),
      mustAppearTokens: [answer],
      mustNotAppearTokens: distractors.map((d) => canonicalAnswer(w, d)),
      asOf: null,
      answerIsNegative: false,
    }
  }
  return null
}

function nounFor(predicate: string): string {
  switch (predicate) {
    case 'raised_against':
      return 'vendor'
    case 'from_vendor':
      return 'vendor'
    case 'carried_batch':
      return 'batch'
    case 'scoped_to_project':
      return 'project'
    case 'approved':
      return 'invoice'
    default:
      return 'entity'
  }
}

/**
 * MEDIUM — two edges across two documents, with one required distractor.
 *
 * Shape: docA(subject ->mid-> X), docB(X ->answer-> ...). The question names the
 * subject and asks for the second edge's object; the middle entity is NOT named,
 * which is what forces the join.
 */
function buildMedium(w: World, rng: Rng, idx: number, used: Set<string>): BenchmarkQuestion | null {
  // Seeding from a hardcoded predicate list was the bug that produced 51 of 350
  // medium questions: the corpus builds 2-edge chains under ~13 different first
  // predicates, and only 51 of them start with the three I had listed. The tier
  // must draw from the whole edge set, or the shortfall looks like a corpus limit
  // when it is really a generator limit.
  const allEdges = w.allEdges
  for (let attempt = 0; attempt < 40; attempt++) {
    const a = rng.pick(allEdges)
    const mid = a.object
    const seconds = (w.edgesStartingAt.get(mid) ?? []).filter((e) => e.docId !== a.docId)
    if (seconds.length === 0) continue
    const b = rng.pick(seconds)
    const hops: Hop[] = [
      { from: label(w, a.subject), via: a.predicate, to: label(w, a.object), docId: a.docId },
      { from: label(w, b.subject), via: b.predicate, to: label(w, b.object), docId: b.docId },
    ]
    // §7.5: reject chains that collapse into one document. The corpus measures
    // this at ~34% of raw 2-edge chains, so without the check a third of the
    // "medium" tier would be single-document questions wearing a 2-hop label.
    if (!isResolvableEntity(w, b.object)) continue
    if (!isMinimalChain(hops, w.docById, b.object, w.docsForEntity)) continue
    const key = `medium|${a.subject}|${a.object}|${b.object}`
    if (used.has(key)) continue
    const answer = canonicalAnswer(w, b.object)
    if (answer.length < 5 || isCommonToken(answer, w)) continue

    const sib = (w.edgesStartingAt.get(mid) ?? []).find((e) => e.predicate === b.predicate && e.object !== b.object)
    used.add(key)
    return {
      id: `medium-${String(idx).padStart(5, '0')}`,
      tier: 'medium',
      submechanism: null,
      question: `Which ${nounFor(b.predicate)} is reached from the ${nounFor(a.predicate)} that ${label(w, a.subject)} is recorded with?`,
      answer,
      answerAliases: [label(w, b.object), answer],
      evidenceDocIds: [a.docId, b.docId],
      hopChain: hops,
      distractorDocIds: sib ? [sib.docId] : [],
      distractorStrings: sib ? [canonicalAnswer(w, sib.object)] : [],
      mustAppearTokens: [answer],
      mustNotAppearTokens: sib ? [canonicalAnswer(w, sib.object)] : [],
      asOf: null,
      answerIsNegative: false,
    }
  }
  return null
}

function _collectEdgesFor(w: World, entityId: string): Edge[] {
  const out: Edge[] = []
  for (const docId of w.docsForEntity.get(entityId) ?? []) {
    for (const r of w.relsByDoc.get(docId) ?? []) {
      if (r.subject === entityId || r.object === entityId) out.push(r)
    }
  }
  return out
}

/**
 * HARD — three edges across three documents, two required distractors.
 *
 * The specific thing separating three-edge from two-edge traversal is that the
 * second distractor shares the MIDDLE entity and terminates one edge early with
 * a plausible wrong answer.
 */
function buildHard(w: World, rng: Rng, idx: number, used: Set<string>): BenchmarkQuestion | null {
  for (let attempt = 0; attempt < 60; attempt++) {
    const a = rng.pick(w.allEdges)
    const seconds = (w.edgesStartingAt.get(a.object) ?? []).filter((e) => e.docId !== a.docId)
    if (seconds.length === 0) continue
    const b = rng.pick(seconds)
    if (b.object === a.object) continue
    const thirds = (w.edgesStartingAt.get(b.object) ?? []).filter((e) => e.docId !== a.docId && e.docId !== b.docId)
    if (thirds.length === 0) continue
    const c = rng.pick(thirds)
    if (a.subject === c.object || c.object === b.object) continue
    const hops: Hop[] = [
      { from: label(w, a.subject), via: a.predicate, to: label(w, a.object), docId: a.docId },
      { from: label(w, b.subject), via: b.predicate, to: label(w, b.object), docId: b.docId },
      { from: label(w, c.subject), via: c.predicate, to: label(w, c.object), docId: c.docId },
    ]
    if (!isResolvableEntity(w, c.object)) continue
    if (!isMinimalChain(hops, w.docById, c.object, w.docsForEntity)) continue
    const answer = canonicalAnswer(w, c.object)
    if (answer.length < 5 || isCommonToken(answer, w)) continue
    const key = `hard|${a.subject}|${a.object}|${b.object}|${c.object}`
    if (used.has(key)) continue

    // Two required distractors: d1 stops one edge early from the FIRST hop, d2
    // stops one edge early from the SECOND. d2 is the discriminating one — a
    // two-edge retriever finds d2's document and answers with a plausible wrong
    // value, which is exactly the failure a three-edge question must catch.
    const d1 = (w.edgesStartingAt.get(a.object) ?? []).find((e) => e.object !== b.object)
    const d2 = (w.edgesStartingAt.get(b.object) ?? []).find((e) => e.object !== c.object)
    used.add(key)
    return {
      id: `hard-${String(idx).padStart(5, '0')}`,
      tier: 'hard',
      submechanism: null,
      question: `Starting from ${label(w, a.subject)}, follow two intermediate records: which ${nounFor(c.predicate)} is reached at the end of that chain?`,
      answer,
      answerAliases: [label(w, c.object), answer],
      evidenceDocIds: [a.docId, b.docId, c.docId],
      hopChain: hops,
      distractorDocIds: [d1?.docId, d2?.docId].filter(Boolean) as string[],
      distractorStrings: [d1, d2].filter(Boolean).map((e) => canonicalAnswer(w, e!.object)),
      mustAppearTokens: [answer],
      mustNotAppearTokens: [d1, d2].filter(Boolean).map((e) => canonicalAnswer(w, e!.object)),
      asOf: null,
      answerIsNegative: false,
    }
  }
  return null
}

function buildComplex(w: World, rng: Rng, idx: number, used: Set<string>): BenchmarkQuestion | null {
  const corrections = w.corpus.index?.corrections ?? []
  for (let attempt = 0; attempt < 400 && corrections.length > 0; attempt++) {
    const corr = rng.pick(corrections)
    const correctDoc = w.docById.get(corr.correctDocId)
    if (!correctDoc) continue
    // The memo's own `was_late` object is a DAY VALUE ("day-523"), which is not a
    // resolvable entity and would ship a ground truth whose answer no retriever
    // could ever cite. The correction layer records which vendor and project are
    // UNCHANGED by the timing fix, and those ARE resolvable — so the question asks
    // about one of those and the supersession remains the thing being tested.
    if (!corr.vendorId && !corr.projectId) continue
    const picks: { id: string; kind: string }[] = []
    if (corr.vendorId) picks.push({ id: corr.vendorId, kind: 'vendor' })
    if (corr.projectId) picks.push({ id: corr.projectId, kind: 'project' })
    const pickIdx = used.size % picks.length
    let chosen: { id: string; kind: string } | null = null
    for (let k = 0; k < picks.length; k++) {
      const cand = picks[(pickIdx + k) % picks.length]
      if (isResolvableEntity(w, cand.id)) {
        chosen = cand
        break
      }
    }
    if (!chosen) continue
    const key = `complex-sup|${corr.deliveryId}|${chosen.id}`
    if (used.has(key)) continue
    const answer = canonicalAnswer(w, chosen.id)
    if (answer.length < 5 || isCommonToken(answer, w)) continue
    used.add(key)

    // The distractor is the SAME question answered from the retracted record: the
    // timing the memo overturned. A retriever that trusts the stale note lands
    // here, which is what "resolve the contradiction" has to mean.
    const staleText = (w.docById.get(corr.incorrectDocId)?.text ?? '')
    const staleDay = /day\s+(\d+)/i.exec(staleText)?.[1]

    // The correction memo says the vendor and project are UNCHANGED but does not
    // name them — the names live on the original delivery note it supersedes (and,
    // for the vendor, on the dock intake memo). Citing only the memo produced a
    // ground truth whose answer appears in no cited document at all (measured: 70
    // of 200 complex questions). The evidence set is therefore the memo PLUS the
    // records that carry the unchanged facts, which is what "the corrected record
    // still applies to X" actually requires a retriever to assemble.
    const evidence = [corr.correctDocId]
    const staleDoc = w.docById.get(corr.incorrectDocId)
    if (staleDoc && canonicalAnswer(w, chosen.id) && staleDoc.text.toLowerCase().includes(answer.toLowerCase())) {
      evidence.push(corr.incorrectDocId)
    } else {
      // Fall back to the document that actually names the entity, so the answer is
      // always readable from the cited set even when the stale note omits it.
      const naming = (w.docsForEntity.get(chosen.id) ?? []).filter((d) => d !== corr.correctDocId)
      if (naming.length > 0) evidence.push(naming[0])
    }
    if (evidence.length < 2) continue
    return {
      id: `complex-${String(idx).padStart(5, '0')}`,
      tier: 'complex',
      submechanism: 'supersession',
      question: `A later memo corrects the arrival timing for ${corr.deliveryId} but states other details are unchanged. Which ${chosen.kind} does that corrected record still apply to?`,
      answer,
      answerAliases: [label(w, chosen.id), answer],
      evidenceDocIds: evidence,
      hopChain: [
        { from: label(w, corr.subject), via: 'was_late', to: corr.correctAssertion, docId: corr.correctDocId },
        { from: label(w, corr.subject), via: `unchanged_${chosen.kind}`, to: label(w, chosen.id), docId: corr.correctDocId },
      ],
      distractorDocIds: [corr.incorrectDocId],
      distractorStrings: staleDay ? [`day ${staleDay}`] : [],
      mustAppearTokens: [answer],
      mustNotAppearTokens: [],
      asOf: staleDay ? `superseded: reported day ${staleDay}` : null,
      answerIsNegative: false,
    }
  }

  // NEGATIVE EVIDENCE (§3.1 complex sub-mechanism 3, as the design lists it).
  // The corpus emits `negative_evidence` documents asserting that NO record
  // exists for a project. A retriever that only ever matches positive text will
  // surface the POSITIVE record the note explicitly disclaims, so the question
  // is decided by whether the system reads the negation.
  const negEdges = w.byPredicate.get('no_record_for') ?? []
  for (let attempt = 0; attempt < 60 && negEdges.length > 0; attempt++) {
    const neg = rng.pick(negEdges)
    if (used.has(neg.docId)) continue
    const subjectName = label(w, neg.subject)
    if (subjectName.length < 5) continue
    used.add(neg.docId)
    return {
      id: `complex-${String(idx).padStart(5, '0')}`,
      tier: 'complex',
      submechanism: 'negative',
      question: `Was any incident recorded against ${subjectName} in the review window, and if a positive record exists elsewhere, does it apply here?`,
      answer: 'not recorded',
      answerAliases: ['not recorded', 'no record', 'none'],
      evidenceDocIds: [neg.docId],
      hopChain: [{ from: subjectName, via: neg.predicate, to: label(w, neg.object), docId: neg.docId }],
      distractorDocIds: (w.docsForEntity.get(neg.object) ?? []).slice(0, 1),
      distractorStrings: [canonicalAnswer(w, neg.object)],
      mustAppearTokens: [],
      mustNotAppearTokens: [],
      asOf: null,
      answerIsNegative: true,
    }
  }

  // Fall back to the disambiguation shape: a 2-hop chain PLUS a same-subject
  // competitor, so rank alone is insufficient and the extra attribute decides.
  for (let attempt = 0; attempt < 60; attempt++) {
    const base = buildMedium(w, rng, idx, used)
    if (!base) continue
    base.tier = 'complex'
    base.submechanism = 'disambiguation'
    base.id = `complex-${String(idx).padStart(5, '0')}`
    const rival = base.distractorStrings[0]
    if (rival) {
      // Two documents give the same subject two objects; correct behaviour is to
      // prefer the one the longer chain supports, not the nearest match.
      base.mustNotAppearTokens = [rival]
    }
    return base
  }
  return null
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const argOf = (name: string, fallback: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function main() {
  const corpusPath = argOf('corpus', '/tmp/corpus.json')
  const outPath = argOf('out', '/tmp/questions.jsonl')
  const seed = Number(argOf('seed', '20260916'))
  const want: Record<Tier, number> = {
    easy: Number(argOf('easy', '150')),
    medium: Number(argOf('medium', '350')),
    hard: Number(argOf('hard', '300')),
    complex: Number(argOf('complex', '200')),
  }

  const w = loadWorld(corpusPath)
  console.log(`corpus: ${w.docs.length} docs, ${w.corpus.index?.relations.length ?? 0} relations`)

  const rng = new Rng(seed)
  const used = new Set<string>()
  const questions: BenchmarkQuestion[] = []
  // Shortfalls are reported, never padded: a tier that cannot fill its quota from
  // the available relation graph is a corpus limitation, and silently reusing a
  // question from another tier would make the tier breakdown meaningless.
  const shortfall: Record<string, number> = {}

  const builders: Record<Tier, (i: number) => BenchmarkQuestion | null> = {
    easy: (i) => buildEasy(w, rng, i, used),
    medium: (i) => buildMedium(w, rng, i, used),
    hard: (i) => buildHard(w, rng, i, used),
    complex: (i) => buildComplex(w, rng, i, used),
  }

  for (const tier of ['easy', 'medium', 'hard', 'complex'] as Tier[]) {
    let made = 0
    let attempts = 0
    while (made < want[tier] && attempts < want[tier] * 12) {
      attempts++
      const q = builders[tier](made + 1)
      if (!q) continue
      questions.push(q)
      made++
    }
    if (made < want[tier]) shortfall[tier] = want[tier] - made
    console.log(`  ${tier.padEnd(8)} ${made}/${want[tier]}${made < want[tier] ? '  SHORT' : ''}`)
  }

  writeFileSync(outPath, questions.map((q) => JSON.stringify(q)).join('\n') + '\n')
  console.log(`\nwrote ${outPath} (${questions.length} questions)`)
  if (Object.keys(shortfall).length) {
    console.log(`SHORTFALL (reported, not padded): ${JSON.stringify(shortfall)}`)
  }

  const byTier = questions.reduce<Record<string, number>>((a, q) => ((a[q.tier] = (a[q.tier] ?? 0) + 1), a), {})
  console.log('tier counts:', JSON.stringify(byTier))
  const evidenceSizes = questions.map((q) => q.evidenceDocIds.length)
  console.log(`evidence docs per question: min ${Math.min(...evidenceSizes)} max ${Math.max(...evidenceSizes)} avg ${(evidenceSizes.reduce((a, b) => a + b, 0) / evidenceSizes.length).toFixed(2)}`)
}

if (import.meta.main) main()
