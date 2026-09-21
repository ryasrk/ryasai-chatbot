#!/usr/bin/env bun
/**
 * supermemory arm for the retrieval comparison — same corpus, same 1000 questions,
 * same evidence rule as the cognee run and the BM25 baseline.
 *
 * WHY THE INPUT IS THE COGNEE ARTIFACT AND NOT THE GENERATOR
 * ---------------------------------------------------------
 * The comparison is only meaningful if all three arms see byte-identical input.
 * `benchmark/results/cognee-1000-results.json` already carries both halves —
 * `corpus.textsById` (all 1200 document texts) and `results[]` (each question with
 * its `evidenceDocIds`) — so this runner reads THAT file and never re-generates.
 * Regenerating would reintroduce the risk the corpus was designed to remove.
 *
 * WHICH supermemory MODE, AND WHY IT IS A DEVIATION TO STATE PLAINLY
 * -----------------------------------------------------------------
 * `taskType: "superrag"` is chosen over the default `"memory"`. The default runs
 * memory EXTRACTION, which rewrites documents into facts about entities; that is a
 * different task from "return the document that answers this question", and the
 * evidence rule below grades exactly the latter. `superrag` chunks and indexes the
 * document text, which is the closest analogue to cognee's `CHUNKS` strategy and to
 * BM25's document index. The mode is printed in the output so the row is never read
 * as a memory-quality measurement.
 *
 * CHUNK-TO-DOCUMENT RESOLUTION (the honest limitation)
 * ----------------------------------------------------
 * supermemory returns CHUNKS, not document ids: the response schema has
 * `{ id, memory?, chunk?, similarity, metadata }`. A chunk may be a SLICE of a
 * document, so "which corpus document is this?" is recovered by finding the corpus
 * text that the returned chunk came from. A chunk that matches no document is
 * counted as NON-evidence, which can only UNDER-report recall. The unmatched count
 * is printed so the reader can see how much of the returned set was ungradeable —
 * the same discipline the cognee runner uses for the same reason.
 *
 * Usage:
 *   bun benchmark/supermemory-arm.ts \
 *     --results=benchmark/results/cognee-1000-results.json \
 *     --base=http://127.0.0.1:6767 --api-key=<key> \
 *     --out-json=benchmark/results/supermemory-1000.json \
 *     --out-md=benchmark/results/supermemory-1000.md
 */
import { readFileSync, writeFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Input contract — the subset of the cognee artifact this needs
// ---------------------------------------------------------------------------

interface CogneeQuestion {
  id: string
  tier: string
  question: string
  answer: string
  evidenceDocIds: string[]
}

interface CogneeArtifact {
  corpus: { documentCount: number; documentIds: string[]; textsById: Record<string, string> }
  results: CogneeQuestion[]
  topK: number
}

interface SearchResult {
  id?: string
  memory?: string
  chunk?: string
  similarity?: number
  metadata?: Record<string, unknown> | null
  /**
   * The source documents, WITH their customId. This is why the arm can grade on
   * ids instead of text: `/v4/search` echoes back the `customId` we ingested each
   * document under, so chunk -> document needs no guessing.
   */
  documents?: { id?: string; title?: string }[]
  chunks?: unknown[]
}

const argOf = (name: string, fallback: string | null = null): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Chunk -> document resolution
// ---------------------------------------------------------------------------

/**
 * Map a search hit to corpus document ids.
 *
 * PRIMARY PATH: `/v4/search` returns `documents[].id`, which is the `customId` the
 * document was ingested under — i.e. the corpus doc id itself. Grading then needs
 * no text matching at all, which matters because §4.3.1 deliberately grades on ids
 * and forbids text containment (a templated corpus quotes other documents'
 * identifiers).
 *
 * FALLBACK: if a hit carries no document ids, a chunk that matches a corpus
 * document's text exactly is resolved by text. A slice that appears in more than
 * one document resolves to NOTHING rather than a guess — a false HIT is invisible
 * in the numbers, a false MISS is visible.
 */
function buildResolver(textsById: Record<string, string>) {
  const byText = new Map<string, string[]>()
  for (const [docId, text] of Object.entries(textsById)) {
    const key = text.trim()
    const list = byText.get(key)
    if (list) list.push(docId)
    else byText.set(key, [docId])
  }

  return (text: string): { docIds: string[]; method: 'id' | 'text' | 'none' } => {
    const needle = text.trim()
    const direct = byText.get(needle)
    if (direct) return { docIds: direct, method: 'text' }
    return { docIds: [], method: 'none' }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function api(
  base: string,
  apiKey: string,
  path: string,
  init: { method: string; body?: unknown; timeoutMs?: number },
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? 180_000)
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ac.signal,
    })
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      /* non-JSON body (an HTML error page) stays in `text` */
    }
    return { ok: res.ok, status: res.status, json, text }
  } catch {
    // Degrade to a failure record; never throw into the run loop.
    return { ok: false, status: 0, json: null, text: 'request failed/aborted' }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const resultsPath = argOf('results', 'benchmark/results/cognee-1000-results.json')!
  const base = argOf('base', 'http://127.0.0.1:6767')!
  const apiKey = argOf('api-key', process.env.SUPERMEMORY_API_KEY ?? '')!
  const containerTag = argOf('tag', 'benchcorpus')!
  const limit = Number(argOf('limit', '10'))
  const taskType = argOf('task-type', 'superrag')!
  const outJson = argOf('out-json', null)
  const outMd = argOf('out-md', null)
  const skipIngest = process.argv.includes('--skip-ingest')

  if (!apiKey) {
    console.error('--api-key=<key> is required (the server prints one on first boot)')
    process.exit(1)
  }

  const art = JSON.parse(readFileSync(resultsPath, 'utf8')) as CogneeArtifact
  const textsById = art.corpus.textsById
  const docIds = Object.keys(textsById)
  const questions = art.results
  console.log(`supermemory arm against ${base}`)
  console.log(`  corpus docs   ${docIds.length} (from ${resultsPath})`)
  console.log(`  questions     ${questions.length}`)
  console.log(`  taskType      ${taskType}   containerTag=${containerTag}   limit=${limit}`)

  const resolve = buildResolver(textsById)

  // --- INGEST ---------------------------------------------------------------
  let ingestMs = 0
  if (!skipIngest) {
    console.log('\n--- INGEST ---')
    // The batch endpoint accepts up to 600 documents per call, so 1200 docs is
    // two calls. customId carries the corpus doc id so a re-run can be matched
    // against what landed rather than trusting a status field.
    const BATCH = 500
    const t0 = Date.now()
    for (let i = 0; i < docIds.length; i += BATCH) {
      const slice = docIds.slice(i, i + BATCH)
      const body = {
        containerTag,
        taskType,
        dreaming: 'instant',
        documents: slice.map((id) => ({ content: textsById[id], customId: id })),
      }
      const res = await api(base, apiKey, '/v3/documents/batch', { method: 'POST', body, timeoutMs: 300_000 })
      const j = res.json as { success?: number; failed?: number } | null
      console.log(
        `  batch ${i / BATCH + 1}: status=${res.status} success=${j?.success ?? '?'} failed=${j?.failed ?? '?'}` +
          (res.ok ? '' : `  body=${res.text.slice(0, 200)}`),
      )
      if (!res.ok) {
        console.error('  ingest failed — stopping so a partial ingest is not graded')
        process.exit(1)
      }
    }
    ingestMs = Date.now() - t0
    console.log(`  ingest wall clock ${(ingestMs / 1000).toFixed(1)}s (${(ingestMs / docIds.length).toFixed(0)}ms/doc submitted)`)

    // Ingestion is ASYNC by design ("Adds are accepted instantly but processed
    // through a queue"). Grading before the queue drains would measure the queue.
    // Poll until search actually returns content for a known phrase.
    console.log('\n--- WAIT FOR QUEUE ---')
    const probeQ = textsById[docIds[0]].split(' ').slice(0, 6).join(' ')
    let ready = false
    for (let attempt = 0; attempt < 720; attempt++) {
      // `/v4/search` for the SAME reason the grading call uses it: v3 returns an
      // empty result set on this build, so probing v3 would wait forever and then
      // blame the corpus for a route regression.
      const r = await api(base, apiKey, '/v4/search', {
        method: 'POST',
        body: { q: probeQ, containerTag, searchMode: 'hybrid', limit: 3, threshold: 0 },
        timeoutMs: 60_000,
      })
      const n = (r.json as { total?: number; results?: unknown[] } | null)?.total ?? 0
      if (n > 0) {
        ready = true
        console.log(`  searchable after ${attempt * 5}s (probe returned ${n})`)
        break
      }
      await sleep(5000)
    }
    if (!ready) {
      console.error('  corpus never became searchable within 60 minutes — aborting rather than scoring a queue artefact')
      process.exit(1)
    }
  } else {
    console.log('\n(ingest skipped — reusing the existing container)')
  }

  // --- RECALL ---------------------------------------------------------------
  console.log('\n--- RECALL ---')
  interface RawQ {
    id: string
    tier: string
    question: string
    answer: string
    evidenceDocIds: string[]
    latencyMs: number
    returned: { text: string; similarity: number | null; resolvedDocIds: string[]; exact: boolean }[]
    errors: string[]
  }
  const raws: RawQ[] = []
  let unmatched = 0
  let returnedChunks = 0

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const t0 = Date.now()
    // `/v4/search`, NOT `/v3/search`. MEASURED on self-hosted v0.0.8: `/v3/search`
    // returns `{"results":[],"total":0}` for every query — including a query that is
    // the document's own exact text — while `/v4/search` returns the same content
    // with a similarity score. The docs still advertise v3, so this is a v3 route
    // regression in this build; the arm must use the route that works, and saying so
    // is the difference between a real comparison and a zero that means nothing.
    const res = await api(base, apiKey, '/v4/search', {
      method: 'POST',
      // threshold 0: the API default is 0.5, a similarity CUTOFF that silently drops
      // results. Leaving it would score supermemory's threshold, not its ranking.
      body: { q: q.question, containerTag, searchMode: 'hybrid', limit, threshold: 0 },
      timeoutMs: 120_000,
    })
    const ms = Date.now() - t0
    const results = ((res.json as { results?: SearchResult[] } | null)?.results ?? []) as SearchResult[]
    const errors: string[] = []
    if (!res.ok) errors.push(`http ${res.status}: ${res.text.slice(0, 120)}`)
    const returned = results.map((r) => {
      const text = (r.chunk ?? r.memory ?? '').trim()
      // ID FIRST: the hit names its source documents, so no text matching is needed.
      const idDocs = (r.documents ?? []).map((d) => d?.id).filter((x): x is string => Boolean(x))
      const resolved = idDocs.length > 0 ? { docIds: idDocs, method: 'id' as const } : resolve(text)
      returnedChunks++
      if (resolved.docIds.length === 0) unmatched++
      return { text, similarity: r.similarity ?? null, resolvedDocIds: resolved.docIds, exact: resolved.method === 'id' }
    })
    raws.push({ id: q.id, tier: q.tier, question: q.question, answer: q.answer, evidenceDocIds: q.evidenceDocIds, latencyMs: ms, returned, errors })
    if ((i + 1) % 100 === 0) console.log(`  [${i + 1}/${questions.length}] elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s(last)`)
  }

  // --- GRADE (same rule as the cognee report and the BM25 baseline) ----------
  const rankOfFinalHop = (ids: string[], ev: string[]): number => {
    const idx = ids.indexOf(ev[ev.length - 1])
    return idx < 0 ? 0 : idx + 1
  }
  const allEvidence = (ids: string[], ev: string[], k: number): boolean => {
    const w = new Set(ids.slice(0, k))
    return ev.every((e) => w.has(e))
  }

  const rows = raws.map((r) => {
    const ids: string[] = []
    for (const h of r.returned) for (const d of h.resolvedDocIds) if (!ids.includes(d)) ids.push(d)
    return { ...r, rankedDocIds: ids }
  })

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const tiers = ['easy', 'medium', 'hard', 'complex', 'ALL']
  const metrics = tiers.map((tier) => {
    const rs = tier === 'ALL' ? rows : rows.filter((r) => r.tier === tier)
    const rank = rs.map((r) => rankOfFinalHop(r.rankedDocIds, r.evidenceDocIds))
    const lat = rs.map((r) => r.latencyMs).sort((a, b) => a - b)
    return {
      tier,
      n: rs.length,
      recall5: mean(rs.map((r) => (allEvidence(r.rankedDocIds, r.evidenceDocIds, 5) ? 1 : 0))),
      recall10: mean(rs.map((r) => (allEvidence(r.rankedDocIds, r.evidenceDocIds, 10) ? 1 : 0))),
      answerAt1: mean(rank.map((x) => (x === 1 ? 1 : 0))),
      mrr: mean(rank.map((x) => (x > 0 ? 1 / x : 0))),
      latencyP50: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
      latencyP90: lat.length ? lat[Math.floor(lat.length * 0.9)] : 0,
    }
  })

  console.log('\n=== supermemory recall (same evidence rule) ===')
  console.log('| tier | n | recall@5 | recall@10 | answer@1 | MRR | p50 ms | p90 ms |')
  console.log('|---|---|---|---|---|---|---|---|')
  for (const m of metrics) {
    console.log(
      `| ${m.tier} | ${m.n} | ${m.recall5.toFixed(4)} | ${m.recall10.toFixed(4)} | ${m.answerAt1.toFixed(4)} | ${m.mrr.toFixed(4)} | ${m.latencyP50} | ${m.latencyP90} |`,
    )
  }

  const overall = metrics.find((m) => m.tier === 'ALL')!
  console.log('\n=== HEAD-TO-HEAD, top-10, identical corpus and questions ===')
  console.log('| arm | recall@10 | answer@1 | MRR |')
  console.log('|---|---|---|---|')
  console.log(`| **supermemory (superrag)** | **${overall.recall10.toFixed(4)}** | **${overall.answerAt1.toFixed(4)}** | **${overall.mrr.toFixed(4)}** |`)
  console.log('| BM25 (no LLM, no graph) | 0.2300 | 0.1660 | 0.2078 |')
  console.log('| cognee 1.5.4 (CHUNKS) | 0.1030 | 0.0390 | 0.0579 |')

  const errCount = rows.filter((r) => r.errors.length > 0).length
  console.log('\n=== GRADEABILITY ===')
  console.log(`  returned chunks            ${returnedChunks}`)
  console.log(`  chunks matching NO corpus doc ${unmatched} (${((100 * unmatched) / Math.max(1, returnedChunks)).toFixed(1)}%) — counted as non-evidence, can only UNDER-report`)
  console.log(`  questions with an API error   ${errCount}`)
  console.log(`  ingest                      ${ingestMs ? (ingestMs / 1000).toFixed(0) + 's submitted' : 'skipped'}`)
  console.log('\n  SCOPE: retrieval only, synthetic corpus, single run. taskType=' + taskType + ' measures')
  console.log('  document retrieval, NOT memory quality (which is what supermemory normally sells).')

  if (outJson) {
    writeFileSync(
      outJson,
      JSON.stringify(
        {
          version: 1,
          kind: 'supermemory-arm',
          base,
          containerTag,
          taskType,
          limit,
          sourceResults: resultsPath,
          corpusDocuments: docIds.length,
          ingestMs,
          returnedChunks,
          unmatchedChunks: unmatched,
          questionsWithError: errCount,
          metrics,
          raw: rows.map((r) => ({
            id: r.id,
            tier: r.tier,
            latencyMs: r.latencyMs,
            evidenceDocIds: r.evidenceDocIds,
            rankedDocIds: r.rankedDocIds,
            errors: r.errors,
            returned: r.returned.map((h) => ({ text: h.text.slice(0, 400), similarity: h.similarity, resolvedDocIds: h.resolvedDocIds })),
          })),
        },
        null,
        2,
      ),
    )
    console.log(`\nwrote ${outJson}`)
  }
  if (outMd) {
    const md = [
      '# supermemory arm — retrieval comparison',
      '',
      `Source corpus/questions: \`${resultsPath}\` (identical to the cognee run and the BM25 baseline).`,
      `taskType=\`${taskType}\` (document retrieval, NOT memory extraction), searchMode=documents, limit=${limit}, threshold=0.`,
      '',
      '| tier | n | recall@5 | recall@10 | answer@1 | MRR | p50 ms | p90 ms |',
      '|---|---|---|---|---|---|---|---|',
      ...metrics.map((m) => `| ${m.tier} | ${m.n} | ${m.recall5.toFixed(4)} | ${m.recall10.toFixed(4)} | ${m.answerAt1.toFixed(4)} | ${m.mrr.toFixed(4)} | ${m.latencyP50} | ${m.latencyP90} |`),
      '',
      '| arm | recall@10 | answer@1 | MRR |',
      '|---|---|---|---|',
      `| supermemory (superrag) | ${overall.recall10.toFixed(4)} | ${overall.answerAt1.toFixed(4)} | ${overall.mrr.toFixed(4)} |`,
      '| BM25 | 0.2300 | 0.1660 | 0.2078 |',
      '| cognee 1.5.4 | 0.1030 | 0.0390 | 0.0579 |',
      '',
      `Gradeability: ${returnedChunks} chunks returned, ${unmatched} unmatched (${((100 * unmatched) / Math.max(1, returnedChunks)).toFixed(1)}%).`,
      '',
    ].join('\n')
    writeFileSync(outMd, md)
    console.log(`wrote ${outMd}`)
  }
}

if (import.meta.main) void main()
