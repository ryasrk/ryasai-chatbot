/**
 * Gate the committed embedding cache (`data/cognee-1000-embeddings.json`).
 *
 * WHY THESE EXIST: every retrieval arm in `benchmark/` scores against this file,
 * so a stale or wrongly-shaped cache would not look like a bug — it would look
 * like a finding ABOUT the retrieval strategy. The similarity tests are the ones
 * that catch a silent failure of the real model: if the file had been produced by
 * a hashed bag-of-words or a random projection, the arms would be measuring the
 * placeholder, exactly as `uat/fixtures/embedding-server-real.py` documents.
 *
 * MEASURED VALUES (paraphrase-multilingual-MiniLM-L12-v2, 384 dims, unit vectors,
 * so cosine is a plain dot product). Pairs are selected by corpus CONTENT, never
 * by picking a flattering score.
 *
 * 1. Shared-identifier pairs, as the task specifies:
 *      28 same-topic pairs (W-01 dock-intake memo x W-01 dock-intake memo)
 *        min 0.804738  doc-0863/doc-0871   max 0.981957  doc-0006/doc-0894
 *      368 cross-topic pairs (every W-01 dock intake x every vendor master)
 *        min 0.175776  doc-0006/doc-0162   max 0.546713  doc-0863/doc-0375
 *      Every cross-topic pair scores below the WORST same-topic pair; margin
 *      0.804738 - 0.546713 = 0.258025, and 0/368 pairs cross it.
 *      Named example from the task: doc-0006/doc-0364 = 0.835149 against
 *      doc-0006/doc-0002 = 0.265633, margin 0.569516.
 *
 * 2. Paraphrase vs shared-boilerplate — the test that actually separates a real
 *    model from lexical scoring. MEASURED CAVEAT: on this corpus, test 1 alone
 *    does NOT discriminate. The corpus is template-generated, so high lexical
 *    overlap and high semantic similarity coincide, and a deterministic hashed
 *    bag-of-words reproduces that ordering with an even WIDER margin (+0.556 vs
 *    the real model's +0.258). Test 1 is kept because the task asks for it and it
 *    pins the identifier-sharing behaviour retrieval depends on — but it cannot
 *    detect a fake embedder on its own.
 *
 *    Test 2 uses two families where the two notions DISAGREE:
 *      - paraphrase family (content-selected: "travel desk quota" +
 *        "cikarang plant canteen") — the same fact stated by two different
 *        templates. 10 pairs.
 *      - shared-boilerplate family (content-selected: the exact
 *        interested-supplier sentences) — pairs whose subject differs, so they
 *        are unrelated facts wearing identical boilerplate. 4855 pairs.
 *                      real cosine          wording overlap (token Jaccard)
 *      paraphrase      mean 0.8450           mean 0.4769
 *                      min  0.7539           min  0.1967
 *      boilerplate     mean 0.6584           mean 0.6687
 *                      min  0.3890           min  0.6042
 *
 *    The real model ranks the PARAPHRASES higher (+0.1866) while wording overlap
 *    ranks them LOWER (-0.1918) — the orderings invert. A deterministic hashed
 *    bag-of-words REVERSES the semantic ordering in 12/12 hash seeds (margins
 *    -0.15..-0.25), so this test fails loudly on a fake embedder where test 1
 *    passes. That is why both are here.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const CORPUS_PATH = new URL('./data/cognee-1000-corpus.json', import.meta.url)
const CACHE_PATH = new URL('./data/cognee-1000-embeddings.json', import.meta.url)
const QUESTIONS_PATH = new URL('./data/cognee-1000-questions.jsonl', import.meta.url)
const QUESTION_CACHE_PATH = new URL('./data/cognee-1000-question-embeddings.json', import.meta.url)

const EXPECTED_DIMENSIONS = 384
const EXPECTED_MODEL = 'paraphrase-multilingual-MiniLM-L12-v2'

interface CorpusDoc {
  id: string
  title: string
  kind: string
  text: string
}

const corpus: { docs: CorpusDoc[] } = JSON.parse(readFileSync(CORPUS_PATH, 'utf-8'))
const cache: {
  model: string
  dimensions: number
  count: number
  vectors: Record<string, number[]>
} = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'))

const vectors = cache.vectors
const docIds = Object.keys(vectors)
const docs = corpus.docs

interface QuestionRow {
  id: string
  tier: string
  question: string
  evidenceDocIds?: string[]
}

const questionRows: QuestionRow[] = readFileSync(QUESTIONS_PATH, 'utf-8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l))

const questionCache: {
  model: string
  dimensions: number
  count: number
  vectors: Record<string, number[]>
} = JSON.parse(readFileSync(QUESTION_CACHE_PATH, 'utf-8'))

const questionVectors = questionCache.vectors
const questionTexts = questionRows.map((r) => r.question)
const distinctQuestionTexts = [...new Set(questionTexts)]

/** Cosine similarity of two cached vectors. Unit-norm vectors => dot product. */
function cosine(a: string, b: string): number {
  const va = vectors[a]
  const vb = vectors[b]
  if (!va) throw new Error(`no cached vector for ${a}`)
  if (!vb) throw new Error(`no cached vector for ${b}`)
  let dot = 0
  for (let i = 0; i < va.length; i++) dot += va[i] * vb[i]
  return dot
}

/** Token-set Jaccard overlap — the lexical score this cache must NOT be reducible to. */
function wordingOverlap(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
  const setB = new Set(b.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
  let shared = 0
  for (const t of setA) if (setB.has(t)) shared++
  return shared / (setA.size + setB.size - shared)
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length

describe('embedding cache shape', () => {
  test('records the model and the raw 384 dims (no 1536 zero-padding)', () => {
    expect(cache.model).toBe(EXPECTED_MODEL)
    expect(cache.dimensions).toBe(EXPECTED_DIMENSIONS)
  })

  test('count matches the vector map and the corpus', () => {
    expect(cache.count).toBe(docIds.length)
    expect(cache.count).toBe(docs.length)
  })

  test('every corpus doc has a vector under its own id, and no extras', () => {
    for (const doc of docs) expect(vectors[doc.id], `no vector for ${doc.id}`).toBeDefined()
    const corpusIds = new Set(docs.map((d) => d.id))
    for (const id of docIds) expect(corpusIds.has(id), `stray vector ${id}`).toBe(true)
  })

  test('every vector has exactly `dimensions` entries', () => {
    for (const id of docIds) {
      expect(vectors[id].length, `vector ${id} has ${vectors[id].length} dims`).toBe(cache.dimensions)
    }
  })

  test('all 384 dims carry signal (guards truncation + zero-padding)', () => {
    // A length check alone cannot catch a 384-vector zero-padded to 1536 and
    // sliced back to 384, which would pass every other shape assertion while
    // making every cosine ~0.
    for (const id of docIds) {
      const v = vectors[id]
      expect(v.slice(-8).some((x) => x !== 0), `vector ${id} has an all-zero tail`).toBe(true)
      expect(v.some((x) => x !== 0), `vector ${id} is all zeros`).toBe(true)
    }
  })
})

describe('embedding cache norms', () => {
  test('every vector is L2-normalised within 1e-3, first and last included', () => {
    expect(docIds[0]).toBe(docs[0].id)
    expect(docIds[docIds.length - 1]).toBe(docs[docs.length - 1].id)
    expect(docIds.length).toBeGreaterThanOrEqual(50)
    // All 1200, not the 50-doc minimum: the loop is milliseconds and sampling
    // would only weaken the gate.
    let worst = 0
    for (const id of docIds) {
      const norm = Math.sqrt(vectors[id].reduce((s, x) => s + x * x, 0))
      worst = Math.max(worst, Math.abs(norm - 1))
      expect(Math.abs(norm - 1), `${id} norm=${norm}`).toBeLessThan(1e-3)
    }
    // Rounding to 6 decimals perturbs each norm by ~1e-6.
    expect(worst).toBeLessThan(1e-3)
  })
})

describe('similarity: shared identifiers', () => {
  // Selected from corpus CONTENT: the W-01 dock-intake memos share the dock, the
  // arrival-day sentence, the gate-timestamp sentence and the receiving-project
  // sentence; a vendor master shares none of them.
  const dockIntake = docs.filter((d) => d.kind === 'warehouse_memo' && d.title === 'Dock intake W-01')
  const vendorMaster = docs.filter((d) => d.kind === 'vendor_master')

  test('the corpus still contains both populations', () => {
    expect(dockIntake.length).toBeGreaterThanOrEqual(2)
    expect(vendorMaster.length).toBeGreaterThanOrEqual(1)
  })

  test('the named pair shares W-01 and the vendor master does not', () => {
    const [a, b] = dockIntake
    expect(a.text).toContain('W-01')
    expect(b.text).toContain('W-01')
    expect(vendorMaster[0].text).toContain('Vendor master record')
    expect(vendorMaster[0].text).not.toContain('W-01')
  })

  test('two dock-intake memos beat a dock-intake memo vs a vendor master', () => {
    const [a, b] = dockIntake
    const similar = cosine(a.id, b.id)
    const unrelated = cosine(a.id, vendorMaster[0].id)
    console.log(
      `[shared-id] ${a.id}~${b.id} = ${similar.toFixed(6)} vs ` +
        `${a.id}~${vendorMaster[0].id} = ${unrelated.toFixed(6)} ` +
        `(margin ${(similar - unrelated).toFixed(6)})`,
    )
    expect(similar).toBeGreaterThan(unrelated)
    expect(similar - unrelated).toBeGreaterThan(0.1)
  })

  test('the WORST same-topic pair still beats the BEST cross-topic pair', () => {
    let worstSame = Infinity
    let worstSamePair = ''
    for (let i = 0; i < dockIntake.length; i++) {
      for (let j = i + 1; j < dockIntake.length; j++) {
        const sim = cosine(dockIntake[i].id, dockIntake[j].id)
        if (sim < worstSame) {
          worstSame = sim
          worstSamePair = `${dockIntake[i].id}/${dockIntake[j].id}`
        }
      }
    }
    let bestCross = -Infinity
    let bestCrossPair = ''
    for (const d of dockIntake) {
      for (const v of vendorMaster) {
        const sim = cosine(d.id, v.id)
        if (sim > bestCross) {
          bestCross = sim
          bestCrossPair = `${d.id}/${v.id}`
        }
      }
    }
    console.log(
      `[shared-id] worst same-topic ${worstSamePair} = ${worstSame.toFixed(6)}; ` +
        `best cross-topic ${bestCrossPair} = ${bestCross.toFixed(6)}; ` +
        `margin ${(worstSame - bestCross).toFixed(6)}`,
    )
    expect(worstSame).toBeGreaterThan(bestCross)
  })

  test('a document compared with itself scores ~1 (cosine helper sanity)', () => {
    // Without this, a broken dot product that returned a constant would satisfy
    // every ordering assertion above.
    const id = dockIntake[0].id
    expect(cosine(id, id)).toBeCloseTo(1, 3)
  })
})

describe('similarity: paraphrase must beat shared boilerplate', () => {
  // Two families selected by content, engineered by the corpus generator to pull
  // semantic and lexical similarity in OPPOSITE directions.
  const paraphrases = docs.filter(
    (d) => d.text.includes('travel desk quota') && d.text.includes('Cikarang plant canteen'),
  )
  const boilerplate = docs.filter(
    (d) =>
      d.text.includes('is listed as an interested supplier for administrative purposes only') &&
      d.text.includes('Interested-supplier lists are cleared each quarter'),
  )

  /** Text before "… was tendered on day" — the part that varies between bulletins. */
  const subjectOf = (text: string) => {
    const m = text.match(/^(.*?)\s+was tendered on day/)
    return m ? m[1].trim().toLowerCase() : null
  }

  const paraphrasePairs: Array<[CorpusDoc, CorpusDoc]> = []
  for (let i = 0; i < paraphrases.length; i++) {
    for (let j = i + 1; j < paraphrases.length; j++) paraphrasePairs.push([paraphrases[i], paraphrases[j]])
  }

  const boilerplatePairs: Array<[CorpusDoc, CorpusDoc]> = []
  for (let i = 0; i < boilerplate.length; i++) {
    for (let j = i + 1; j < boilerplate.length; j++) {
      const a = boilerplate[i]
      const b = boilerplate[j]
      if (subjectOf(a.text) === null || subjectOf(a.text) !== subjectOf(b.text)) {
        boilerplatePairs.push([a, b])
      }
    }
  }

  test('both content-selected families are present and well-formed', () => {
    expect(paraphrases.length).toBeGreaterThanOrEqual(3)
    expect(boilerplate.length).toBeGreaterThanOrEqual(20)
    expect(paraphrasePairs.length).toBeGreaterThanOrEqual(3)
    expect(boilerplatePairs.length).toBeGreaterThanOrEqual(20)
    // The families must genuinely differ: boilerplate pairs share far more words.
    const bp = mean(boilerplatePairs.map(([a, b]) => wordingOverlap(a.text, b.text)))
    const pp = mean(paraphrasePairs.map(([a, b]) => wordingOverlap(a.text, b.text)))
    console.log(
      `[paraphrase] wording overlap: paraphrase mean ${pp.toFixed(4)} ` +
        `vs boilerplate mean ${bp.toFixed(4)} (margin ${(pp - bp).toFixed(4)})`,
    )
    expect(pp).toBeLessThan(bp)
  })

  test('the real model ranks paraphrases ABOVE shared-boilerplate pairs', () => {
    const pp = mean(paraphrasePairs.map(([a, b]) => cosine(a.id, b.id)))
    const bp = mean(boilerplatePairs.map(([a, b]) => cosine(a.id, b.id)))
    const bpWording = mean(boilerplatePairs.map(([a, b]) => wordingOverlap(a.text, b.text)))
    const ppWording = mean(paraphrasePairs.map(([a, b]) => wordingOverlap(a.text, b.text)))
    console.log(
      `[paraphrase] cosine: paraphrase mean ${pp.toFixed(6)} vs boilerplate mean ${bp.toFixed(6)} ` +
        `(margin ${(pp - bp).toFixed(6)}); wording overlap moves the OTHER way ` +
        `(${ppWording.toFixed(4)} < ${bpWording.toFixed(4)})`,
    )
    expect(pp).toBeGreaterThan(bp)
    // A margin this size is what a real semantic model buys; a hashed
    // bag-of-words inverts the sign (measured: -0.15..-0.25 across 12 seeds).
    expect(pp - bp).toBeGreaterThan(0.1)
  })

  test('the separation holds across the whole population, not just the means', () => {
    // Measured: 4855 boilerplate pairs, 10 paraphrase pairs.
    //   paraphrase cosine  min 0.753903  median 0.790780  max 0.984118
    //   boilerplate cosine min 0.388955  median 0.651108  max 0.941043
    //
    // NOTE, deliberately not asserted as an absolute floor: the paraphrase MIN
    // does NOT exceed the boilerplate MAX (0.7539 < 0.9410). The strongest
    // boilerplate pair is doc-1006/doc-1162 (0.941043) and it genuinely IS closely
    // related — "canteen restock at the Surabaya branch" vs "cafeteria menu review
    // at the Surabaya branch", same site AND same vendor. Ranking it high is
    // correct, not a defect, so a naive "no pair crosses" assertion would be
    // false. What IS asserted is that the separation is overwhelmingly one-sided:
    // 84.16% of the 4855 boilerplate pairs fall below the single worst paraphrase
    // pair, despite sharing far more wording.
    const paraphraseCosines = paraphrasePairs.map(([a, b]) => cosine(a.id, b.id)).sort((x, y) => x - y)
    const boilerplateCosines = boilerplatePairs.map(([a, b]) => cosine(a.id, b.id)).sort((x, y) => x - y)
    const worstParaphrase = paraphraseCosines[0]
    const boilerplateMedian = boilerplateCosines[Math.floor(boilerplateCosines.length / 2)]
    const belowParaphraseFloor =
      boilerplateCosines.filter((c) => c < worstParaphrase).length / boilerplateCosines.length
    console.log(
      `[paraphrase] worst paraphrase = ${worstParaphrase.toFixed(6)}; ` +
        `boilerplate median = ${boilerplateMedian.toFixed(6)}; ` +
        `${(belowParaphraseFloor * 100).toFixed(2)}% of ${boilerplateCosines.length} boilerplate ` +
        `pairs fall below the worst paraphrase pair`,
    )
    expect(boilerplateCosines.length).toBeGreaterThan(1000)
    expect(worstParaphrase).toBeGreaterThan(boilerplateMedian)
    expect(belowParaphraseFloor).toBeGreaterThan(0.8)
  })
})

/**
 * QUESTION CACHE
 *
 * `Arm.rank(question, ctx, budget)` gets the question as a STRING, so a vector arm
 * needs query vectors, not just document vectors — and embedding inside `rank()`
 * would bill a model call to the timed region, making the latency budget
 * meaningless. Query vectors are therefore precomputed offline by the same model
 * instance, and keyed by the EXACT question text because that is the lookup the
 * harness performs.
 *
 * MEASURED: the questions file has 1000 lines but only 569 DISTINCT question
 * strings — 431 rows repeat a text already present (208 texts repeat, one of them
 * five times). The cache is keyed by text, so duplicates collapse to one entry:
 * count 569, not 1000. That is intentional and reported by the script's summary
 * line, not a silent truncation. The assertions below pin BOTH numbers so a future
 * regeneration cannot quietly start dropping questions.
 *
 * Retrieval sanity measured through these query vectors against the document
 * cache (cosine top-k, dot product): recall@1 = 0.0960, recall@10 = 0.3680 over
 * the 1000 rows that carry `evidenceDocIds`. That is weak-but-real retrieval, as
 * expected for a 384-dim MiniLM on identifier-heavy prose — it confirms the query
 * and document vectors share one space. It is deliberately NOT asserted as a
 * quality floor: it is a property of the model, not of this cache's correctness.
 */
describe('question cache', () => {
  test('records the same model and dimensions as the document cache', () => {
    expect(questionCache.model).toBe(EXPECTED_MODEL)
    expect(questionCache.model).toBe(cache.model)
    expect(questionCache.dimensions).toBe(EXPECTED_DIMENSIONS)
  })

  test('count matches the number of DISTINCT question strings', () => {
    expect(distinctQuestionTexts.length).toBe(569)
    expect(questionCache.count).toBe(distinctQuestionTexts.length)
    expect(questionCache.count).toBe(Object.keys(questionVectors).length)
    // Documents the deliberate collapse, so the gap is never mistaken for a bug.
    expect(questionTexts.length).toBe(1000)
    expect(questionTexts.length - distinctQuestionTexts.length).toBe(431)
  })

  test('every question in the questions file has an entry, keyed by exact text', () => {
    for (const row of questionRows) {
      expect(questionVectors[row.question], `no vector for question ${row.id}`).toBeDefined()
    }
    // And no stale entries for questions that no longer exist.
    const live = new Set(distinctQuestionTexts)
    for (const key of Object.keys(questionVectors)) {
      expect(live.has(key), `stale question vector key ${JSON.stringify(key)}`).toBe(true)
    }
  })

  test('every question vector has exactly 384 dims and carries signal', () => {
    for (const key of Object.keys(questionVectors)) {
      const v = questionVectors[key]
      expect(v.length, `question vector ${JSON.stringify(key.slice(0, 40))} has ${v.length} dims`).toBe(
        questionCache.dimensions,
      )
      expect(v.slice(-8).some((x) => x !== 0)).toBe(true)
    }
  })

  test('every question vector is L2-normalised within 1e-3', () => {
    let worst = 0
    for (const key of Object.keys(questionVectors)) {
      const norm = Math.sqrt(questionVectors[key].reduce((s, x) => s + x * x, 0))
      worst = Math.max(worst, Math.abs(norm - 1))
      expect(Math.abs(norm - 1), `${JSON.stringify(key.slice(0, 40))} norm=${norm}`).toBeLessThan(1e-3)
    }
    console.log(`[questions] ${Object.keys(questionVectors).length} vectors, worst norm error ${worst}`)
    expect(worst).toBeLessThan(1e-3)
  })

  test('question vectors live in the document space (retrieval sanity)', () => {
    // A question vector in the wrong space would still be unit-norm, so the shape
    // and norm checks cannot catch it. This measures it directly: for every
    // question carrying evidence, compare the mean cosine to its OWN evidence
    // documents against the mean cosine to a fixed sample of unrelated documents.
    //
    // MEASURED over all 1000 questions: mean evidence cosine 0.493935 vs mean
    // unrelated cosine 0.312204 — margin +0.181731, and the evidence side wins for
    // 962 of 1000 questions (0.9620). (A separate Python probe with a different
    // unrelated sample measured 0.319003 / +0.174932 / 965 wins, so the result does
    // not hinge on the sample.) A single hand-picked question is NOT used as the
    // gate: the first identifier question tried ("Which vendor is delivery DL-106
    // associated with?") clears a filler document by only 0.003217, so gating on one
    // pair would be flaky. Related measured context: cosine top-k recall@10 is
    // 0.3680 (median best-evidence rank 21), which is weak-but-real retrieval for a
    // 384-dim MiniLM on identifier-heavy prose — enough to prove one shared space,
    // and NOT asserted as a quality floor since it is a property of the model
    // rather than of this cache's correctness.
    const withEvidence = questionRows.filter(
      (r) => questionVectors[r.question] && (r.evidenceDocIds?.length ?? 0) > 0,
    )
    expect(withEvidence.length).toBeGreaterThan(500)

    // Deterministic unrelated sample: stride through the doc list, never re-fetching
    // the same tail (a fixed seed keeps this file's numbers stable across runs).
    const sampleSize = 20
    const stride = Math.max(1, Math.floor(docs.length / sampleSize))
    const unrelatedIds = Array.from({ length: sampleSize }, (_, i) => docs[(i * stride) % docs.length].id)

    let wins = 0
    let evidenceSum = 0
    let unrelatedSum = 0
    for (const row of withEvidence) {
      const qv = questionVectors[row.question]
      const score = (docId: string) => {
        const dv = vectors[docId]
        if (!dv) return 0
        let dot = 0
        for (let i = 0; i < qv.length; i++) dot += qv[i] * dv[i]
        return dot
      }
      const evidence = row.evidenceDocIds!.filter((d) => vectors[d])
      if (evidence.length === 0) continue
      const evidenceMean = evidence.reduce((s, d) => s + score(d), 0) / evidence.length
      const others = unrelatedIds.filter((d) => !row.evidenceDocIds!.includes(d))
      const unrelatedMean = others.reduce((s, d) => s + score(d), 0) / others.length
      evidenceSum += evidenceMean
      unrelatedSum += unrelatedMean
      if (evidenceMean > unrelatedMean) wins++
    }
    const meanEvidence = evidenceSum / withEvidence.length
    const meanUnrelated = unrelatedSum / withEvidence.length
    console.log(
      `[questions] mean cosine to own evidence ${meanEvidence.toFixed(6)} vs unrelated ` +
        `${meanUnrelated.toFixed(6)} (margin ${(meanEvidence - meanUnrelated).toFixed(6)}); ` +
        `evidence wins for ${wins}/${withEvidence.length} questions`,
    )
    expect(meanEvidence).toBeGreaterThan(meanUnrelated)
    expect(meanEvidence - meanUnrelated).toBeGreaterThan(0.05)
    expect(wins / withEvidence.length).toBeGreaterThan(0.8)
  })
})
