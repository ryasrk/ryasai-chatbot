#!/usr/bin/env bun
/**
 * BM25 baseline for the cognee benchmark — the row that decides whether the
 * graph layer earns its place.
 *
 * WHY THIS EXISTS
 * ---------------
 * `benchmark/results/cognee-1000-report.md` reports `bm25_naive` as NOT
 * COMPUTABLE and then states the consequence itself:
 *
 *   "without this row, the cognee score above is not interpretable"
 *
 * That is not a formality. The committed run scores recall@10 = 0.1030 overall
 * (medium and hard both 0.0000). A plain lexical index over the same corpus
 * might score 0.30 — in which case the graph layer is WORSE than a keyword
 * search while costing an LLM pipeline per document — or 0.03, in which case
 * the graph is doing real work. Those are opposite conclusions about whether to
 * keep the dependency, and nothing recorded so far distinguishes them.
 *
 * WHY IT NEEDS NO SERVER
 * ----------------------
 * The runner persists `corpus.textsById` (all 1200 document texts) plus every
 * question's `evidenceDocIds` into the raw results file. BM25 is a pure function
 * of those two things, so this recomputes the baseline offline, deterministically,
 * from the committed artifact — no cognee, no embedding endpoint, no re-ingest.
 *
 * WHY THIS IS REAL BM25 AND NOT A PROXY
 * -------------------------------------
 * The report warns that a token-overlap proxy "would be quoted as though it were
 * BM25". This implements Okapi BM25 with the standard k1/b, per-corpus IDF and
 * length normalisation, and grades through the SAME evidence-id rule the report
 * uses (`evidence_hit@k` = every evidence doc among the top-k), so the two rows
 * are directly comparable.
 *
 * NOT A POSTGRES ts_rank REPLACEMENT. Design §6.4 also allows Postgres `ts_rank`;
 * that adds stemming and a different tokenizer. This is the portable arm. A
 * divergence between the two would itself be worth knowing, so the choice is
 * printed in the output rather than left implicit.
 *
 * Determinism: no PRNG, no sampling, no tie-breaking on insertion order beyond
 * the documented `(score desc, docId asc)` rule. Re-running yields identical
 * numbers, so a score change between two commits is a real change.
 *
 * Usage:
 *   bun benchmark/cognee-bm25-baseline.ts \
 *       --results=benchmark/results/cognee-1000-results.json \
 *       --out-json=benchmark/results/cognee-1000-bm25.json
 */
import { readFileSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Raw-input contract (the subset of the runner's output this needs)
// ---------------------------------------------------------------------------

interface RawChunk {
  rank: number
  docIdsInText?: string[]
}

interface RawQuestion {
  id: string
  tier: string
  submechanism: string | null
  question: string
  answer: string
  evidenceDocIds: string[]
  retrieval: { chunks: RawChunk[] }
}

interface RawResults {
  dataset: string
  topK: number
  corpus: { documentCount: number; textsById: Record<string, string>; documentIds: string[] }
  results: RawQuestion[]
}

/**
 * BM25 parameters. k1 = 1.2 / b = 0.75 are the values from the original
 * Robertson/Sparck Jones work and the ones every reference BM25 uses, so a
 * reader comparing against a textbook implementation sees the same numbers.
 * They are CLI-overridable because b controls how hard long documents are
 * penalised, and this corpus mixes one-sentence memos with multi-sentence
 * briefings.
 */
interface Bm25Params {
  k1: number
  b: number
}

const DEFAULT_PARAMS: Bm25Params = { k1: 1.2, b: 0.75 }

// ---------------------------------------------------------------------------
// Tokenisation
// ---------------------------------------------------------------------------

/**
 * Lowercase alphanumeric tokens of length >= 2.
 *
 * Length 1 is dropped because single letters are noise on this corpus. Note the
 * deliberate omission of stemming: cognee's own retrieval is not stemmed
 * either, so stemmed BM25 would be a stronger baseline than the comparison
 * needs. If BM25 still beats the graph layer without stemming, that is the
 * stronger finding, not the weaker one.
 *
 * Hyphenated identifiers (INV-4471, DL-106, B-2291) are kept WHOLE and also
 * split, because these are exactly the tokens the hard/complex questions turn
 * on and dropping the joined form would understate the baseline.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]/g) ?? []) {
    out.push(raw)
    if (raw.includes('-')) {
      for (const part of raw.split('-')) if (part.length >= 2) out.push(part)
    }
  }
  return out.filter((t) => t.length >= 2)
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export interface Bm25Index {
  /** docId -> term frequencies. */
  tf: Map<string, Map<string, number>>
  /** docId -> token count (BM25's `|D|`). */
  len: Map<string, number>
  /** term -> number of documents containing it (BM25's `n(qi)`). */
  df: Map<string, number>
  /** Mean document length across the corpus (BM25's `avgdl`). */
  avgdl: number
  /** Total documents (BM25's `N`). */
  n: number
}

export function buildIndex(textsById: Record<string, string>): Bm25Index {
  const tf = new Map<string, Map<string, number>>()
  const len = new Map<string, number>()
  const df = new Map<string, number>()
  let total = 0

  for (const [docId, text] of Object.entries(textsById)) {
    const tokens = tokenize(text)
    const counts = new Map<string, number>()
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
    tf.set(docId, counts)
    len.set(docId, tokens.length)
    total += tokens.length
    // Document frequency counts DOCUMENTS, not occurrences — a term repeated
    // 10 times in one document must not inflate its own IDF.
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1)
  }

  return { tf, len, df, avgdl: Object.keys(textsById).length ? total / Object.keys(textsById).length : 0, n: Object.keys(textsById).length }
}

/**
 * Okapi BM25 score of `docId` for `query`.
 *
 *   score = Σ_idf(qi) · ( f(qi,D)·(k1+1) ) / ( f(qi,D) + k1·(1 − b + b·|D|/avgdl) )
 *   idf   = ln( 1 + (N − n(qi) + 0.5) / (n(qi) + 0.5) )
 *
 * The `ln(1 + ...)` form is the non-negative IDF variant; the textbook
 * `ln((N−n+0.5)/(n+0.5))` goes NEGATIVE for terms in more than half the corpus,
 * which would let a common word subtract from a document's score.
 */
export function score(index: Bm25Index, docId: string, queryTerms: string[], params: Bm25Params = DEFAULT_PARAMS): number {
  const counts = index.tf.get(docId)
  if (!counts) return 0
  const dl = index.len.get(docId) ?? 0
  const { k1, b } = params
  let score_ = 0

  // Deduplicate query terms: a word repeated in the question must not multiply
  // its own contribution, which is the standard treatment (BM25 sums over the
  // DISTINCT query terms).
  for (const term of new Set(queryTerms)) {
    const f = counts.get(term)
    if (!f) continue
    const nqi = index.df.get(term) ?? 0
    const idf = Math.log(1 + (index.n - nqi + 0.5) / (nqi + 0.5))
    const denom = f + k1 * (1 - b + (b * dl) / (index.avgdl || 1))
    score_ += idf * ((f * (k1 + 1)) / denom)
  }
  return score_
}

/**
 * Top-k document ids for a question.
 *
 * Ties are broken by docId ASCENDING rather than by map iteration order. This
 * matters: `Map` iteration follows insertion order, so without an explicit
 * tie-break the baseline would silently depend on how the corpus file happened
 * to be ordered, and two runs of the same data could differ.
 */
export function topK(index: Bm25Index, query: string, k: number, params: Bm25Params = DEFAULT_PARAMS): string[] {
  const terms = tokenize(query)
  const scored: { docId: string; score: number }[] = []
  for (const docId of index.tf.keys()) {
    const s = score(index, docId, terms, params)
    if (s > 0) scored.push({ docId, score: s })
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0))
  return scored.slice(0, k).map((s) => s.docId)
}

// ---------------------------------------------------------------------------
// Grading — the SAME rule the main report uses, so the rows are comparable
// ---------------------------------------------------------------------------

/** §4.3.1: every evidence doc must appear among the top-k. Unordered containment on ids. */
export function evidenceHitAtK(rankedDocIds: string[], evidenceDocIds: string[], k: number): boolean {
  const window = new Set(rankedDocIds.slice(0, k))
  return evidenceDocIds.every((id) => window.has(id))
}

/**
 * Rank of the first top-k hit whose document is the question's FINAL hop.
 *
 * Mirrors the report's `answer_at_rank_1`: the final hop is the document that
 * actually carries the answer, so ranking it first is the meaningful ordering
 * signal. 0 means not present in the window.
 */
export function finalHopRank(rankedDocIds: string[], evidenceDocIds: string[]): number {
  const finalHop = evidenceDocIds[evidenceDocIds.length - 1]
  const idx = rankedDocIds.indexOf(finalHop)
  return idx < 0 ? 0 : idx + 1
}

interface TierMetrics {
  tier: string
  n: number
  recall5: number
  recall10: number
  recall20: number
  answerAt1: number
  mrr: number
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const argOf = (name: string, fallback: string | null = null): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function main(): void {
  const resultsPath = argOf('results', 'benchmark/results/cognee-1000-results.json')!
  const outJson = argOf('out-json', null)
  const k1 = Number(argOf('k1', String(DEFAULT_PARAMS.k1)))
  const b = Number(argOf('b', String(DEFAULT_PARAMS.b)))
  const params: Bm25Params = { k1, b }

  const raw = JSON.parse(readFileSync(resultsPath, 'utf8')) as RawResults
  const texts = raw.corpus.textsById
  const docCount = Object.keys(texts).length

  console.log(`BM25 baseline over ${resultsPath}`)
  console.log(`  corpus documents   ${docCount}`)
  console.log(`  questions          ${raw.results.length}`)
  console.log(`  params             k1=${k1} b=${b}`)
  console.log(`  comparison window  top-${raw.topK} (same as the recorded cognee run)`)

  const t0 = Date.now()
  const index = buildIndex(texts)
  console.log(`  index built in     ${Date.now() - t0}ms (avgdl=${index.avgdl.toFixed(1)} tokens)`)

  // Grade every question in a single pass.
  interface PerQuestion {
    id: string
    tier: string
    rankOfFinalHop: number
    evidenceIn5: boolean
    evidenceIn10: boolean
    evidenceIn20: boolean
    rr: number
  }
  const perQuestion: PerQuestion[] = []

  for (const q of raw.results) {
    // Window of 20 so recall@20 can be reported; the recorded cognee run caps at
    // 10, which is why the report marks its own recall@20 NOT COMPUTABLE. BM25
    // has no such cap, and comparing at a k the other arm cannot reach would be
    // misleading — the report prints both and says which is comparable.
    const ranked = topK(index, q.question, 20, params)
    const rank = finalHopRank(ranked, q.evidenceDocIds)
    perQuestion.push({
      id: q.id,
      tier: q.tier,
      rankOfFinalHop: rank,
      evidenceIn5: evidenceHitAtK(ranked, q.evidenceDocIds, 5),
      evidenceIn10: evidenceHitAtK(ranked, q.evidenceDocIds, 10),
      evidenceIn20: evidenceHitAtK(ranked, q.evidenceDocIds, 20),
      rr: rank > 0 ? 1 / rank : 0,
    })
  }

  const tiers = ['easy', 'medium', 'hard', 'complex']
  const metrics: TierMetrics[] = []
  for (const tier of [...tiers, 'ALL']) {
    const rows = tier === 'ALL' ? perQuestion : perQuestion.filter((r) => r.tier === tier)
    metrics.push({
      tier,
      n: rows.length,
      recall5: mean(rows.map((r) => (r.evidenceIn5 ? 1 : 0))),
      recall10: mean(rows.map((r) => (r.evidenceIn10 ? 1 : 0))),
      recall20: mean(rows.map((r) => (r.evidenceIn20 ? 1 : 0))),
      answerAt1: mean(rows.map((r) => (r.rankOfFinalHop === 1 ? 1 : 0))),
      mrr: mean(rows.map((r) => r.rr)),
    })
  }

  console.log('\n=== BM25 recall (evidence rule: ALL evidence docs in the top-k) ===')
  console.log('| tier | n | recall@5 | recall@10 | recall@20 | answer@1 | MRR |')
  console.log('|---|---|---|---|---|---|---|')
  for (const m of metrics) {
    console.log(`| ${m.tier} | ${m.n} | ${m.recall5.toFixed(4)} | ${m.recall10.toFixed(4)} | ${m.recall20.toFixed(4)} | ${m.answerAt1.toFixed(4)} | ${m.mrr.toFixed(4)} |`)
  }

  const overall = metrics.find((m) => m.tier === 'ALL')!

  // --- SELF-CONTROLS. Always run, never optional. ---------------------------
  // A control that can be skipped is a control that will be absent, and the
  // whole reason this baseline exists is that the earlier probe printed a 100%
  // beside no control at all. These two run on every invocation:
  //
  //   1. Gibberish queries must return NOTHING. If an unworded query scores,
  //      the corpus or the tokenizer is leaking rather than matching.
  //   2. The same rankings graded against a RANDOM evidence id must collapse
  //      toward chance. If real and random score alike, `evidenceHitAtK` is not
  //      measuring retrieval and no row above is trustworthy.
  console.log('\n=== SELF-CONTROLS (must pass before the row above is quotable) ===')
  const gibberish = ['zzqx', 'wobble', 'frandanglorp', 'quintz', 'blorptastic', 'vidrizzle']
  let gibberishHits = 0
  for (let i = 0; i < 200; i++) {
    const q = Array.from({ length: 4 }, (_, j) => gibberish[(i * 7 + j * 3) % gibberish.length]).join(' ')
    if (topK(index, q, 10, params).length > 0) gibberishHits++
  }
  const gibberishOk = gibberishHits === 0
  console.log(`  gibberish queries with any hit: ${gibberishHits}/200 ${gibberishOk ? 'PASS' : 'FAIL (expected 0)'}`)

  // Deterministic "random" evidence id per question: step through the document
  // id list by a coprime stride so the same ids are picked on every run.
  const docIds = raw.corpus.documentIds
  const stride = 7919 // prime, coprime with 1200, so the walk visits many ids
  const sample = raw.results.slice(0, 300)
  let realHits = 0
  let randomHits = 0
  sample.forEach((q, i) => {
    const ranked = topK(index, q.question, 10, params)
    if (evidenceHitAtK(ranked, q.evidenceDocIds, 10)) realHits++
    if (evidenceHitAtK(ranked, [docIds[(i * stride) % docIds.length]], 10)) randomHits++
  })
  const randomOk = randomHits < realHits / 10
  console.log(
    `  real evidence ${realHits}/${sample.length} vs random-id ${randomHits}/${sample.length} ` +
      `${randomOk ? 'PASS' : 'FAIL (real must exceed random by 10x)'}`,
  )
  const controlsPass = gibberishOk && randomOk

  console.log('\n=== HOW TO READ THIS AGAINST THE RECORDED COGNEE ROW ===')
  console.log(`  BM25     recall@10 = ${overall.recall10.toFixed(4)}   answer@1 = ${overall.answerAt1.toFixed(4)}   MRR = ${overall.mrr.toFixed(4)}`)
  console.log('  cognee   recall@10 = 0.1030   answer@1 = 0.0390   MRR = 0.0579  (benchmark/results/cognee-1000-report.md)')
  const verdict =
    overall.recall10 > 0.103
      ? 'BM25 WINS on recall@10. The graph layer does not currently beat a keyword index on this corpus.'
      : overall.recall10 < 0.103
        ? 'cognee wins on recall@10. The graph layer is adding retrieval value over a keyword index here.'
        : 'TIE on recall@10 to 4 decimals. No retrieval-value claim is supportable either way.'
  console.log(`  => ${verdict}`)
  if (!controlsPass) {
    console.log('\n  !! A SELF-CONTROL FAILED — the comparison above is NOT quotable. Fix the')
    console.log('  harness before citing any number from this run.')
  }
  console.log('\n  SCOPE: recall only, on ONE synthetic corpus, single run, no trials. This row makes')
  console.log('  the cognee number INTERPRETABLE; it does not by itself justify keeping or removing')
  console.log('  the dependency. Latency and ingest cost are separate lines in the main report.')
  console.log('  The recorded cognee artifact does NOT record which embedding model served the run,')
  console.log('  so a fixture difference cannot be ruled out from the artifact alone.')

  if (outJson) {
    writeFileSync(
      outJson,
      JSON.stringify(
        {
          version: 1,
          kind: 'bm25-baseline',
          sourceResults: resultsPath,
          params,
          corpusDocuments: docCount,
          questions: raw.results.length,
          comparisonWindow: raw.topK,
          controls: { gibberishHits, gibberishExpectedZero: true, realHits, randomHits, sampleSize: sample.length, pass: controlsPass },
          metrics,
          perQuestion,
        },
        null,
        2,
      ),
    )
    console.log(`\nwrote ${outJson}`)
  }
}

if (import.meta.main) main()
