#!/usr/bin/env bun
/**
 * RUNNER — write a corpus into a cognee dataset, then ask every question through
 * recall and record the RAW results. It scores nothing.
 * ----------------------------------------------------------------------------
 * WHY THE RAW-OUTPUT SPLIT
 *
 * `cognee-quality-probe.ts` (read-only input to this file) returned 100% on its
 * first live run and the number was worthless: the store held 6 items, so
 * whatever the retriever did, the answer came back — and every hit arrived with
 * its own decoy. Two things fixed that there and are load-bearing here:
 *
 *   1. A per-question record that keeps the returned text and the per-hit
 *      `source`, so a miss can be READ rather than guessed at.
 *   2. The results are persisted raw and re-scorable. The grader
 *      (`cognee-benchmark-report.ts`) is a pure function over this file, so a
 *      scoring bug is fixed by re-running the report, never by re-ingesting.
 *      A full 12,000-document ingest is hours of LLM extraction; re-running it to
 *      fix a regex would be the most expensive mistake available here.
 *
 * WHY THE WRITES ARE BATCHED
 *
 * Measured on this server: a `remember` call costs ~654 ms/doc in batches of ~50
 * and ~5 s for a single document, because each call runs the whole cognify
 * pipeline (chunk, embed, LLM entity extraction, graph write). One document per
 * call is a 7.6x cost for identical stored content, so the batch size is a
 * throughput parameter, not a style choice. At `--docs=12000` the difference is
 * ~2.2 h versus ~16 h.
 *
 * WHY 429s ABORT
 *
 * Design §9 threat 10 records this repo already published a run where 196/200
 * responses were rate-limit refusals and every one of them scored as a miss.
 * Empty results therefore are NOT scored as misses silently: they are recorded
 * as `aborted` on the question, and five consecutive 429s stop the run and write
 * out what was collected with `aborted: true` in the header.
 *
 * Usage:
 *   bun benchmark/cognee-retrieval-runner.ts --corpus=/tmp/corpus.json \
 *       --questions=/tmp/questions.jsonl --out=/tmp/raw.json \
 *       --dataset=bench:cognee1000:corpus --mode=retrieval
 *
 * Re-running must not re-ingest: pass `--skip-ingest` to reuse a dataset that is
 * already populated. Ingest is the only expensive, non-idempotent step.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { cogneeRemember, cogneeRecall, cogneeServerVersion, cogneeListDatasets } from '../src/lib/cognee-http'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argOf = (name: string, fallback: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const numOf = (name: string, fallback: number): number => {
  const raw = argOf(name, String(fallback))
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    // A typo'd numeric flag silently taking its default is how a 1,000-question
    // run turns into a 50-question run that still prints a rate.
    console.error(`--${name}=${raw} is not a number`)
    process.exit(2)
  }
  return n
}
const has = (name: string): boolean => process.argv.includes(`--${name}`)

export type Tier = 'easy' | 'medium' | 'hard' | 'complex'
export type Mode = 'retrieval' | 'answer' | 'both'

export interface QuestionRecord {
  id: string
  tier: Tier
  submechanism?: string | null
  question: string
  answer: string
  answerAliases: string[]
  evidenceDocIds: string[]
  hopChain?: unknown[]
  distractorDocIds: string[]
  distractorStrings: string[]
  mustAppearTokens: string[]
  mustNotAppearTokens: string[]
  asOf?: string | null
  answerIsNegative?: boolean
}

interface RetrievedChunk {
  rank: number
  chunkId: string
  source: string | null
  score: number | null
  searchType: string | null
  text: string
  /** Corpus documents this chunk resolved to — see `resolveChunkDocs` for the mechanism and its limit. */
  docIdsInText: string[]
  textTruncated: boolean
}

export interface QuestionResult {
  id: string
  tier: Tier
  submechanism?: string | null
  question: string
  answer: string
  answerAliases: string[]
  evidenceDocIds: string[]
  distractorStrings: string[]
  mustNotAppearTokens: string[]
  answerIsNegative: boolean
  /** null = the recall call failed or was aborted; the report must not read it as a miss. */
  retrieval: {
    searchType: string
    latencyMs: number
    requestedTopK: number
    hitsReturned: number
    chunks: RetrievedChunk[]
    citations: string[]
    aborted: string | null
  } | null
  /** HYBRID_COMPLETION returns exactly one LLM-synthesized answer, not a ranking. */
  synthesized: {
    searchType: string
    latencyMs: number
    citations: string[]
    text: string
    aborted: string | null
  } | null
  /** Raw error text, kept so a run that failed for an infrastructure reason is diagnosable. */
  errors: string[]
}

export interface RawResults {
  version: string
  kind: 'cognee-retrieval-raw'
  startedAt: string
  finishedAt: string | null
  aborted: boolean
  abortReason: string | null
  cogneeVersion: string | null
  baseUrl: string
  dataset: string
  /** Audit Fix 6: Record embedding metadata so the results artifact is self-describing. */
  embeddingModel: string | null
  embeddingDimensions: number | null
  embeddingEndpoint: string | null
  /** Mode decides which per-question series exist; mixing modes in one file would merge series. */
  mode: Mode
  searchType: string
  answerSearchType: string
  topK: number
  concurrency: number
  corpus: {
    path: string
    documentCount: number
    documentIds: string[]
    /** Doc id → the exact text written for it, so a baseline can be computed without re-reading the corpus. */
    textsById: Record<string, string>
  }
  questions: {
    path: string
    total: number
    byTier: Record<string, number>
  }
  ingest: {
    skipped: boolean
    batchSize: number
    batches: number
    documentsWritten: number
    itemsProcessed: number
    /**
     * Independent evidence that the write landed. `status: 'completed'` is NOT
     * evidence — the rejected 0.2.0 binding reported success in 25 ms while
     * writing nothing (design §9 threat 14), which is the migration doc's
     * central lesson.
     */
    probeFound: boolean
    probeDocId: string | null
    probeChunks: number
    perBatchMs: number[]
    perBatchDocs: number[]
    totalMs: number
    msPerDoc: number | null
    errors: string[]
  }
  results: QuestionResult[]
}

// ---------------------------------------------------------------------------
// Corpus ingest
// ---------------------------------------------------------------------------

interface CorpusDoc {
  id: string
  text: string
}

/**
 * Chunk → corpus-document id, resolved by TEXT IDENTITY.
 *
 * WHY NOT BY DOCUMENT ID: this was measured, not assumed. cognee 1.5.4 does not
 * return a source document id on a search hit (`source` is the retrieval
 * *operation* — 'graph' | 'vector' — and hits carry no `id`/`metadata`), and the
 * chunk text it returns carries no embedded `doc-NNNN` marker either. A live
 * smoke run recovered 0 document ids from 180 returned chunks, so any id-based
 * grading scheme is unmeasurable on this server.
 *
 * WHAT REPLACES IT: each corpus document is written as one `remember` item, and
 * the server returns that item's text BYTE-EXACT (measured: 163/180 chunks in the
 * smoke run matched a corpus document text exactly). So the mapping is recovered
 * by looking the returned text up in corpus text→id. This is exact, not a
 * heuristic — but it is only safe while no two corpus documents share a text and
 * no document's text is a prefix of another's, because a truncated chunk would
 * otherwise be ambiguous. `assertCorpusFileNames` (called before ingest) enforces
 * exactly that, and refuses the run when the corpus violates it.
 *
 * LIMITATION, stated because it changes what the numbers mean: a chunk is matched
 * only on an EXACT full-document text, so a chunk the server truncated, re-split,
 * or synthesized (SUMMARIES / any *_COMPLETION strategy) resolves to no document
 * and is treated as non-evidence. That can only make recall@k UNDER-report, never
 * over-report. The report surfaces the count of unmatched chunks so the reader can
 * see how much of the returned set was ungradeable.
 */
export function resolveChunkDocs(
  text: string,
  byText: Map<string, string[]>,
): { docIds: string[]; exact: boolean } {
  const direct = byText.get(text)
  if (direct) return { docIds: direct, exact: true }
  // A chunk that CONTAINS a whole document's text is that document plus a
  // neighbouring one joined by the chunker. Matched only when the containment is
  // unique, so a merged chunk cannot be attributed to an arbitrary member.
  const contained = [...byText.entries()].filter(([docText]) => docText.length > 0 && text.includes(docText))
  if (contained.length === 1) return { docIds: contained[0][1], exact: false }
  return { docIds: [], exact: false }
}

/** Text → the document ids carrying it. Empty entries are dropped so a blank doc cannot match every empty chunk. */
function indexCorpusTexts(docs: CorpusDoc[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const d of docs) {
    if (!d.text) continue
    const list = map.get(d.text)
    if (list) list.push(d.id)
    else map.set(d.text, [d.id])
  }
  return map
}

/**
 * The precondition for text-identity grading. A duplicate text makes two documents
 * one retrieval target (so a "miss" on one is really a hit on the other); a prefix
 * makes a truncated chunk ambiguous. Either one silently turns the recall numbers
 * into a measurement of the harness, which is the failure this whole design exists
 * to prevent — so the run refuses rather than reporting a number with a caveat.
 */
function assertCorpusFileNames(docs: CorpusDoc[]): string | null {
  const byText = new Map<string, string[]>()
  for (const d of docs) {
    if (!d.text) return `corpus document ${d.id} has empty text`
    const list = byText.get(d.text)
    if (list) list.push(d.id)
    else byText.set(d.text, [d.id])
  }
  for (const [text, ids] of byText) {
    if (ids.length > 1) {
      return (
        `corpus documents ${ids.join(', ')} have IDENTICAL text (${text.slice(0, 60)}...); ` +
        `chunk-to-document grading would be ambiguous. Refusing to ingest.`
      )
    }
  }
  const texts = [...byText.keys()]
  for (const a of texts) {
    for (const b of texts) {
      if (a !== b && b.startsWith(a)) {
        return (
          `corpus document text ${JSON.stringify(a.slice(0, 40))} is a PREFIX of another document's text; ` +
          `a truncated chunk would be ambiguous. Refusing to ingest.`
        )
      }
    }
  }
  return null
}

function chunkTexts(texts: string[], size: number): string[][] {
  const out: string[][] = []
  for (let i = 0; i < texts.length; i += size) out.push(texts.slice(i, i + size))
  return out
}

async function ingest(
  opts: { baseUrl: string; timeoutMs: number },
  args: {
    docs: CorpusDoc[]
    dataset: string
    skip: boolean
    batchSize: number
    raws: RawResults
    resume?: boolean
    restartEvery?: number
    restartCmd?: string
    onProgress?: () => void
  },
): Promise<boolean> {
  const { docs, dataset, skip, batchSize, raws, resume, restartEvery, restartCmd, onProgress } = args
  const total = docs.length

  const datasets = await cogneeListDatasets(opts)
  if (skip) {
    // An ingest-skipped run must NOT erase a throughput figure recorded by an
    // earlier ingest run into the same file: the ms/doc number is the whole point
    // of measuring ingestion, and a later `--skip-ingest` run has no way to
    // re-derive it. Only mark the flag when there is nothing to preserve.
    const hadMeasurement = raws.ingest.documentsWritten > 0
    if (!hadMeasurement) {
      raws.ingest.skipped = true
      raws.ingest.batchSize = batchSize
    }
    console.log(`ingest skipped; dataset list: ${JSON.stringify(datasets)}`)
    if (hadMeasurement) {
      console.log(
        `  preserving the earlier ingest measurement: ${raws.ingest.documentsWritten} docs, ` +
          `${raws.ingest.msPerDoc?.toFixed(0)}ms/doc`,
      )
    }
    if (!datasets.includes(dataset)) {
      console.error(
        `--skip-ingest was passed but dataset "${dataset}" does not exist. ` +
          `Run without --skip-ingest first, or pass the dataset that holds the corpus.`,
      )
      return false
    }
    console.log(`  reusing dataset "${dataset}" (${total} corpus docs are expected to be in it)`)
    return true
  }

  const nameProblem = assertCorpusFileNames(docs)
  if (nameProblem) {
    console.error(nameProblem)
    return false
  }
  if (datasets.includes(dataset)) {
    if (resume && raws.ingest.documentsWritten > 0) {
      if (raws.ingest.documentsWritten >= total) {
        console.log(`dataset "${dataset}" already contains all ${total} docs; skipping ingest`)
        return true
      }
      console.log(`dataset "${dataset}" already exists; resuming ingest from ${raws.ingest.documentsWritten}/${total} docs`)
    } else {
      // Appending a second copy of the corpus doubles every document and silently
      // turns recall@k into a tie between two identical chunks.
      console.error(
        `dataset "${dataset}" already exists. Re-ingesting would duplicate the corpus. ` +
          `Pass --skip-ingest to reuse it, or --dataset=<other-name>.`,
      )
      return false
    }
  }

  const batches = chunkTexts(
    docs.map((d) => d.text),
    batchSize,
  )
  raws.ingest.batchSize = batchSize
  raws.ingest.batches = batches.length
  console.log(`ingest: ${total} docs in ${batches.length} batches of ${batchSize} → dataset "${dataset}"`)

  let startIndex = 0
  if (raws.ingest.documentsWritten > 0) {
    startIndex = raws.ingest.perBatchDocs.length
    console.log(`resuming ingest from batch ${startIndex + 1}/${batches.length} (${raws.ingest.documentsWritten} docs already written)`)
  }

  const restartServer = async () => {
    if (!restartCmd) return
    console.log(`  [restart] running ${restartCmd} to recycle cognee server...`)
    try {
      const proc = spawnSync(restartCmd, { stdio: 'pipe' })
      if (proc.status !== 0) {
        console.error(`  [restart] failed with exit code ${proc.status}: ${proc.stderr?.toString()}`)
      }
    } catch (e) {
      console.error(`  [restart] error executing restartCmd: ${e}`)
    }
    for (let k = 0; k < 30; k++) {
      try {
        const h = await fetch(`${opts.baseUrl}/health`)
        if (h.ok) {
          console.log(`  [restart] server healthy at ${opts.baseUrl}`)
          return
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000))
    }
    console.error(`  [restart] server failed to become healthy within 30s`)
  }

  const t0 = Date.now() - (raws.ingest.totalMs || 0)
  let docsSinceLastRestart = 0

  for (let i = startIndex; i < batches.length; i++) {
    const currentBatch = batches[i]
    let res: Awaited<ReturnType<typeof cogneeRemember>> = null
    let err: string | null = null
    let b0 = Date.now()
    const maxAttempts = 3

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      b0 = Date.now()
      err = null
      res = null
      try {
        // remember() returns null for a transport failure, which is indistinguishable
        // from an empty answer, so a thrown error is captured separately.
        res = await cogneeRemember(opts, {
          // One raw_data entry per document: separate strings give the extractor one
          // document each, which is what makes per-document id grading meaningful.
          texts: currentBatch,
          datasetName: dataset,
          runInBackground: false,
          timeoutMs: 1_800_000,
        })
      } catch (e) {
        err = e instanceof Error ? e.message : String(e)
      }

      const items = res?.items_processed ?? 0
      const isOk = !err && res && !res.error && items > 0
      if (isOk) break

      console.warn(`  [retry] batch ${i + 1}/${batches.length} attempt ${attempt}/${maxAttempts} failed: ${err ?? res?.error ?? 'null / 0 items'}`)
      if (attempt < maxAttempts) {
        await restartServer()
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    const ms = Date.now() - b0
    const items = res?.items_processed ?? 0
    raws.ingest.perBatchMs.push(ms)
    raws.ingest.perBatchDocs.push(currentBatch.length)
    raws.ingest.documentsWritten += currentBatch.length
    raws.ingest.itemsProcessed += items

    const failed = !!err || !res || !!res.error
    if (failed) {
      const msg = `batch ${i + 1}/${batches.length}: ${err ?? res?.error ?? 'cogneeRemember returned null'}`
      raws.ingest.errors.push(msg)
      console.error(`  FAIL ${msg}`)
    } else if (items <= 0) {
      // `status: 'completed'` with 0 items is the exact shape of the 0.2.0 false
      // success. Treat it as a failed batch, never as a written one.
      const msg = `batch ${i + 1}/${batches.length}: items_processed=${items} (status=${res!.status ?? '(none)'})`
      raws.ingest.errors.push(msg)
      console.error(`  FAIL ${msg}`)
    }

    const doneDocs = raws.ingest.perBatchDocs.reduce((a, b) => a + b, 0)
    const elapsed = Date.now() - t0
    const msPerDoc = elapsed / Math.max(1, doneDocs)
    const remaining = Math.round(((total - doneDocs) * msPerDoc) / 1000)
    console.log(
      `  ingest ${doneDocs}/${total} docs  ${(elapsed / 1000).toFixed(1)}s elapsed  ` +
        `${msPerDoc.toFixed(0)}ms/doc  ETA ${remaining}s  (batch ${ms}ms, items=${items})`,
    )

    onProgress?.()

    docsSinceLastRestart += currentBatch.length
    if (restartEvery && docsSinceLastRestart >= restartEvery && i + 1 < batches.length) {
      console.log(`  [segment] reached ${docsSinceLastRestart} docs since last restart, recycling server...`)
      await restartServer()
      docsSinceLastRestart = 0
    }
  }

  raws.ingest.totalMs = Date.now() - t0
  raws.ingest.msPerDoc = raws.ingest.totalMs / Math.max(1, raws.ingest.documentsWritten)

  // Independent count: a single id-targeted recall proves SOMETHING was written.
  // It cannot count the corpus — CHUNKS does not honour topK exactly, so "returned
  // every chunk in one call" is not available and 12,000 ids cannot be walked. The
  // report carries this limitation explicitly.
  const probeDoc = docs[0]
  const probeQuery = probeDoc.text.slice(0, 60)
  const hits = await cogneeRecall(opts, {
    query: probeQuery,
    datasets: [dataset],
    searchType: 'CHUNKS',
    topK: 5,
    timeoutMs: 120_000,
  })
  raws.ingest.probeDocId = probeDoc.id
  raws.ingest.probeChunks = hits?.length ?? 0
  raws.ingest.probeFound = (hits ?? []).some((h) => (h.text ?? '').includes(probeDoc.text.slice(0, 40)))
  if (!raws.ingest.probeFound) {
    raws.ingest.errors.push(`post-ingest probe for ${probeDoc.id} found no matching chunk`)
  }

  console.log(
    `ingest done: ${raws.ingest.documentsWritten} docs in ${(raws.ingest.totalMs / 1000).toFixed(1)}s ` +
      `(${raws.ingest.msPerDoc?.toFixed(0)}ms/doc, items_processed=${raws.ingest.itemsProcessed})`,
  )
  console.log(`  independent probe: ${raws.ingest.probeFound ? 'FOUND' : 'NOT FOUND'} ${probeDoc.id} in ${raws.ingest.probeChunks} chunks`)
  return true
}

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

const MAX_CHUNK_CHARS = 2000
const MAX_ANSWER_CHARS = 8000
/** Consecutive 429s tolerated before the run stops (§9 threat 10). */
const RATE_LIMIT_STREAK_LIMIT = 5

function describeError(hits: unknown[] | null, err: string | null): string | null {
  if (err) return err
  if (hits === null) return 'recall failed (transport error, timeout, or non-2xx response)'
  return null
}

function is429(hits: unknown[] | null, err: string | null): boolean {
  // The transport collapses every non-2xx into null and does not surface the
  // status, so a 429 is only detectable when the server lets the message through.
  return !!err && /429|rate ?limit|too many requests/i.test(err)
}

interface CogneeHitWithId {
  id?: string
  metadata?: Record<string, unknown>
}

function toChunks(
  hits: Awaited<ReturnType<typeof cogneeRecall>>,
  byText: Map<string, string[]>,
): RetrievedChunk[] {
  return (hits ?? []).map((h, i) => {
    const text = h.text ?? ''
    // Recall returns the chunk's own id at the TOP level when present; metadata
    // only appears if the caller asked for it. Recorded for diagnostics even
    // though grading cannot use either (see `resolveChunkDocs`).
    const withId = h as CogneeHitWithId
    const chunkId = String(withId.id ?? withId.metadata?.id ?? '')
    // Truncation is applied AFTER resolution: clipping first could cut a document
    // text short and make it unmatchable, which would score as a miss.
    const resolved = resolveChunkDocs(text, byText)
    const clipped = text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text
    return {
      rank: i + 1,
      chunkId,
      source: h.source ?? null,
      score: (h.score ?? null) as number | null,
      searchType: h.search_type ?? null,
      text: clipped,
      docIdsInText: resolved.docIds,
      textTruncated: text.length > MAX_CHUNK_CHARS,
    }
  })
}

async function recallOne(
  opts: { baseUrl: string; timeoutMs: number },
  q: QuestionRecord,
  dataset: string,
  searchType: string,
  topK: number,
  byText: Map<string, string[]>,
): Promise<{ result: QuestionResult['retrieval']; rawError: string | null }> {
  let hits: Awaited<ReturnType<typeof cogneeRecall>> = null
  let err: string | null = null
  const t0 = Date.now()
  try {
    hits = await cogneeRecall(opts, { query: q.question, datasets: [dataset], searchType, topK, timeoutMs: 120_000 })
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  const latencyMs = Date.now() - t0
  return {
    result: {
      searchType,
      latencyMs,
      requestedTopK: topK,
      hitsReturned: hits?.length ?? 0,
      chunks: toChunks(hits, byText),
      citations: ((hits ?? []) as Array<{ dataset_name?: string }>).map((h) => h.dataset_name ?? '').filter(Boolean),
      aborted: describeError(hits, err),
    },
    rawError: err,
  }
}

async function synthesizeOne(
  opts: { baseUrl: string; timeoutMs: number },
  q: QuestionRecord,
  dataset: string,
  searchType: string,
  topK: number,
): Promise<{ result: QuestionResult['synthesized']; rawError: string | null }> {
  let hits: Awaited<ReturnType<typeof cogneeRecall>> = null
  let err: string | null = null
  const t0 = Date.now()
  try {
    hits = await cogneeRecall(opts, { query: q.question, datasets: [dataset], searchType, topK, timeoutMs: 240_000 })
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  const latencyMs = Date.now() - t0
  const text = (hits ?? [])
    .map((h) => h.text ?? '')
    .join('\n')
    .slice(0, MAX_ANSWER_CHARS)
  return {
    result: {
      searchType,
      latencyMs,
      citations: ((hits ?? []) as Array<{ dataset_name?: string }>).map((h) => h.dataset_name ?? '').filter(Boolean),
      text,
      aborted: describeError(hits, err),
    },
    rawError: err,
  }
}

/** Bounded-concurrency map that NEVER rejects — one failure must not abort a 1,000-question run. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      try {
        out[index] = await fn(items[index], index)
      } catch (e) {
        // Only reachable if fn throws outside its own guards; recorded as a
        // discarded slot rather than an exception that would kill the workers.
        console.error(`  worker error on item ${index}: ${e instanceof Error ? e.message : String(e)}`)
        out[index] = undefined as unknown as R
      }
    }
  })
  await Promise.all(workers)
  return out
}

// ---------------------------------------------------------------------------
// Input loading
// ---------------------------------------------------------------------------

function loadQuestions(path: string): QuestionRecord[] {
  const raw = readFileSync(path, 'utf8').trim()
  // Accept JSONL (the generator's output) and a JSON array, because a hand-written
  // smoke set is easier to author as an array and both shapes carry the same records.
  const records: QuestionRecord[] = raw.startsWith('[')
    ? (JSON.parse(raw) as QuestionRecord[])
    : raw
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('//'))
        .map((l) => JSON.parse(l) as QuestionRecord)

  const problems: string[] = []
  records.forEach((q, i) => {
    const where = q?.id ? `question ${q.id}` : `record ${i}`
    if (!q?.id) problems.push(`${where}: missing id`)
    if (!q?.question) problems.push(`${where}: missing question text`)
    if (!q?.answer) problems.push(`${where}: missing answer`)
    if (!Array.isArray(q?.evidenceDocIds) || q.evidenceDocIds.length === 0) {
      problems.push(`${where}: missing evidenceDocIds (retrieval grading is impossible without them)`)
    }
    if (!q?.tier) problems.push(`${where}: missing tier`)
  })
  if (problems.length) {
    // Grading a question with no evidence set would silently count as a miss.
    console.error(`questions file ${path} is not usable:\n  ${problems.slice(0, 20).join('\n  ')}`)
    process.exit(2)
  }
  return records
}

function percentileCaveat(n: number): string {
  return n < 150 ? ' percentiles below n=150 are 2-3 samples, not a distribution' : ''
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<number> {
  const corpusPath = argOf('corpus', '/tmp/corpus.json')
  const questionsPath = argOf('questions', '/tmp/questions.jsonl')
  const outPath = argOf('out', `/tmp/cognee-raw-${Date.now()}.json`)
  const baseUrl = argOf('base', 'http://127.0.0.1:8099')
  const dataset = argOf('dataset', 'bench:cognee1000:corpus')
  const topK = numOf('topk', 10)
  const mode = argOf('mode', 'retrieval') as Mode
  const concurrency = numOf('concurrency', 6)
  const limit = numOf('limit', 0)
  const batchSize = numOf('batch', 25)
  const restartEvery = numOf('restart-every', 300)
  const restartCmd = argOf('restart-cmd', '/tmp/restart-cognee.sh')
  const searchType = argOf('search-type', 'CHUNKS')
  const answerSearchType = argOf('answer-search-type', 'HYBRID_COMPLETION')
  const skipIngest = has('skip-ingest') || has('skipIngest')
  const resume = has('resume')

  if (!['retrieval', 'answer', 'both'].includes(mode)) {
    console.error(`--mode=${mode} must be retrieval|answer|both`)
    return 2
  }

  const opts = { baseUrl, timeoutMs: 300_000 }
  const version = await cogneeServerVersion(opts)
  if (!version) {
    console.error(`cognee server unreachable at ${baseUrl}. Start it before running.`)
    return 1
  }

  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { docs: CorpusDoc[]; index?: unknown }
  if (!Array.isArray(corpus.docs) || corpus.docs.length === 0) {
    console.error(`${corpusPath} has no docs[] — is it benchmark/cognee-corpus.ts output?`)
    return 2
  }
  const byText = indexCorpusTexts(corpus.docs)

  let questions = loadQuestions(questionsPath)
  if (limit > 0) {
    // Interleave tiers so a --limit=20 smoke run exercises every tier rather than
    // only the 20 easiest, which would report a ceiling as a finding.
    const byTier = new Map<string, QuestionRecord[]>()
    for (const q of questions) {
      const list = byTier.get(q.tier)
      if (list) list.push(q)
      else byTier.set(q.tier, [q])
    }
    const picked: QuestionRecord[] = []
    let round = 0
    while (picked.length < limit) {
      let added = 0
      for (const list of byTier.values()) {
        if (round < list.length && picked.length < limit) {
          picked.push(list[round])
          added++
        }
      }
      if (added === 0) break
      round++
    }
    questions = picked
  }

  const raws: RawResults = {
    version: '1',
    kind: 'cognee-retrieval-raw',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    aborted: false,
    abortReason: null,
    cogneeVersion: version,
    baseUrl,
    dataset,
    embeddingModel: process.env.EMBEDDING_MODEL ?? process.env.COGNEE_EMBEDDING_MODEL ?? null,
    embeddingDimensions: process.env.EMBEDDING_DIMENSIONS ? Number(process.env.EMBEDDING_DIMENSIONS) : null,
    embeddingEndpoint: process.env.EMBEDDING_ENDPOINT ?? null,
    mode,
    searchType,
    answerSearchType,
    topK,
    concurrency,
    corpus: {
      path: corpusPath,
      documentCount: corpus.docs.length,
      documentIds: corpus.docs.map((d) => d.id),
      textsById: Object.fromEntries(corpus.docs.map((d) => [d.id, d.text])),
    },
    questions: {
      path: questionsPath,
      total: questions.length,
      byTier: questions.reduce<Record<string, number>>((a, q) => ((a[q.tier] = (a[q.tier] ?? 0) + 1), a), {}),
    },
    ingest: {
      skipped: false,
      batchSize,
      batches: 0,
      documentsWritten: 0,
      itemsProcessed: 0,
      probeFound: false,
      probeDocId: null,
      probeChunks: 0,
      perBatchMs: [],
      perBatchDocs: [],
      totalMs: 0,
      msPerDoc: null,
      errors: [],
    },
    results: [],
  }

  // A resume file is only valid for the same dataset AND corpus size: results
  // keyed to a different corpus would be compared against the wrong document set.
  if (resume) {
    try {
      const prev = JSON.parse(readFileSync(outPath, 'utf8')) as RawResults
      if (prev.dataset !== dataset || prev.topK !== topK || prev.mode !== mode) {
        console.error(
          `--resume: ${outPath} was written for dataset=${prev.dataset} topK=${prev.topK} mode=${prev.mode}; ` +
            `this run is dataset=${dataset} topK=${topK} mode=${mode}. Refusing to merge.`,
        )
        return 2
      }
      if (prev.corpus.documentCount !== raws.corpus.documentCount) {
        console.error(
          `--resume: ${outPath} used a ${prev.corpus.documentCount}-document corpus, this run has ${raws.corpus.documentCount}. ` +
            `Refusing to merge.`,
        )
        return 2
      }
      raws.results = prev.results ?? []
      raws.ingest = prev.ingest
      console.log(`resume: ${raws.results.length} question results already recorded in ${outPath}`)
    } catch {
      console.log(`resume: no usable file at ${outPath}, starting fresh`)
    }
  }

  console.log(`cognee ${version} at ${baseUrl} — dataset "${dataset}"`)
  console.log(`corpus   ${raws.corpus.documentCount} docs from ${corpusPath}`)
  console.log(`questions ${questions.length} from ${questionsPath} ${JSON.stringify(raws.questions.byTier)}`)
  console.log(`mode=${mode} searchType=${searchType} answerSearchType=${answerSearchType} topK=${topK} concurrency=${concurrency}`)

  const t0 = Date.now()
  // Persist often enough that a crash costs minutes, not hours. Every write is a
  // full rewrite: a half-appended JSON file is unreadable, which is worse than
  // paying the extra I/O for a file that is still valid after a kill -9.
  const flush = () => {
    raws.finishedAt = new Date().toISOString()
    writeFileSync(outPath, JSON.stringify(raws, null, 1))
  }

  if (
    !(await ingest(opts, {
      docs: corpus.docs,
      dataset,
      skip: skipIngest,
      batchSize,
      raws,
      resume,
      restartEvery,
      restartCmd,
      onProgress: flush,
    }))
  ) {
    flush()
    return 1
  }
  flush()

  const todo = questions.filter((q) => !raws.results.some((r) => r.id === q.id))
  if (todo.length !== questions.length) console.log(`skipping ${questions.length - todo.length} already-recorded questions`)
  console.log(`recall: ${todo.length} questions at concurrency ${concurrency}${percentileCaveat(todo.length)}`)

  let done = 0
  let consecutive429 = 0
  const byId = new Map<string, QuestionResult>()
  let lastFlush = Date.now()

  await mapBounded(todo, concurrency, async (q) => {
    const record: QuestionResult = {
      id: q.id,
      tier: q.tier,
      submechanism: q.submechanism ?? null,
      question: q.question,
      answer: q.answer,
      answerAliases: q.answerAliases ?? [],
      evidenceDocIds: q.evidenceDocIds ?? [],
      distractorStrings: q.distractorStrings ?? [],
      mustNotAppearTokens: q.mustNotAppearTokens ?? [],
      answerIsNegative: !!q.answerIsNegative,
      retrieval: null,
      synthesized: null,
      errors: [],
    }

    if (mode === 'retrieval' || mode === 'both') {
      const { result, rawError } = await recallOne(opts, q, dataset, searchType, topK, byText)
      record.retrieval = result
      if (result?.aborted) record.errors.push(`retrieval: ${result.aborted}`)
      if (is429(null, rawError)) consecutive429++
      else consecutive429 = 0
    }
    if (mode === 'answer' || mode === 'both') {
      const { result, rawError } = await synthesizeOne(opts, q, dataset, answerSearchType, topK)
      record.synthesized = result
      if (result?.aborted) record.errors.push(`answer: ${result.aborted}`)
      if (is429(null, rawError)) consecutive429++
      else consecutive429 = 0
    }

    raws.results.push(record)
    byId.set(q.id, record)
    done++

    const elapsed = (Date.now() - t0) / 1000
    const rate = done / elapsed
    const eta = rate > 0 ? Math.round((todo.length - done) / rate) : 0
    const detail = record.retrieval
      ? `${record.retrieval.hitsReturned}ch`
      : record.synthesized
        ? `${record.synthesized.text.length}chars`
        : 'ERR'
    const latency = record.retrieval?.latencyMs ?? record.synthesized?.latencyMs ?? '?'
    console.log(
      `  [${done}/${todo.length}] ${q.id} ${q.tier} ${latency}ms ${detail} elapsed ${elapsed.toFixed(0)}s ETA ${eta}s`,
    )

    if (Date.now() - lastFlush > 15_000) {
      lastFlush = Date.now()
      flush()
    }

    if (consecutive429 >= RATE_LIMIT_STREAK_LIMIT) {
      raws.aborted = true
      raws.abortReason = `${RATE_LIMIT_STREAK_LIMIT} consecutive rate-limit responses; the remainder scored as misses would be a rate-limiter artefact, not a retrieval result (§9 threat 10)`
      throw new Error('abort: rate limit streak')
    }
  }).catch((e) => {
    console.error(`run stopped: ${e instanceof Error ? e.message : String(e)}`)
  })

  raws.results.sort((a, b) => a.id.localeCompare(b.id))
  flush()
  console.log(`\nwrote ${outPath} — ${raws.results.length} question results`)
  if (raws.aborted) {
    console.error(`RUN ABORTED: ${raws.abortReason}`)
    console.error('The report will refuse to print a headline number for an aborted run.')
    return 1
  }
  return 0
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('runner failed:', e)
      process.exit(1)
    })
}
