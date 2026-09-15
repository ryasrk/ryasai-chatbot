#!/usr/bin/env bun
/**
 * Cognee server — knowledge-graph QUALITY probe.
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * docs/cognee-http-migration.md proves the memory MECHANISM end to end: a fact
 * written over HTTP is persisted and recalled in a later, unrelated session. It
 * explicitly does NOT prove the graph is any GOOD, and the doc says so:
 *
 *     "Multi-hop graph *quality* is unverified. What is proven is the mechanism:
 *      write, persist, and recall across sessions."
 *
 * That gap matters because the whole reason to run cognee at all (rather than
 * plain vector RAG) is relationship traversal — "who approved the invoice from
 * the vendor that also supplied the defective batch?". A graph that only ever
 * returns the chunk it was handed back is an expensive chunk store.
 *
 * So this probe asks questions whose answer is NOT in any single sentence. Each
 * scenario plants two facts that only CONNECT through an entity, then asks a
 * question that requires following that link. Every expected token is chosen so
 * that its presence can only come from the graph having joined both facts, and a
 * distractor token (present in the corpus but wrong for this question) makes a
 * lucky substring match fail loudly instead of looking plausible.
 *
 * WHAT IT MEASURES (and what it does not)
 *
 *   - REPORTED: per-question hit/miss, plus recall latency. A miss is a miss; the
 *     probe prints the actual returned text so a failure can be read, not
 *     guessed at.
 *   - NOT MEASURED: faithfulness of a synthesized answer. We score RETRIEVAL, not
 *     the LLM's prose. A question can score a hit while the final chat answer is
 *     still wrong — retrieval recall is a necessary, not sufficient, condition.
 *     Do not quote these numbers as answer accuracy.
 *
 * RUNNING IT
 *
 *   cognee server on :8099 with a FRESH store (see docs/cognee-http-migration.md)
 *   LLM gateway + embedding fixture alive, or every write fails
 *
 *   bun scripts/cognee-quality-probe.ts --base=http://127.0.0.1:8099
 *
 * The store is scratch; this script never touches a real org's dataset.
 */
import { cogneeRemember, cogneeRecall, cogneeServerVersion, cogneeListDatasets } from '../src/lib/cognee-http'

const argOf = (name: string, fallback: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const BASE = argOf('base', 'http://127.0.0.1:8099')
const DATASET = argOf('dataset', 'probe:quality')

/**
 * A two-fact scenario. `link` is the shared entity; the question must traverse
 * from the subject THROUGH the link to reach the answer.
 *
 * `expected` tokens must appear ONLY if both facts were joined. `distractor` is
 * a token that exists in the corpus, is plausible, and would appear if the
 * system returned the wrong link — so a shallow keyword match cannot pass.
 */
interface Scenario {
  name: string
  facts: [string, string]
  question: string
  expected: string
  distractor: string
  /** Plain-language statement of the traversal the answer requires. */
  reasoning: string
}

const SCENARIOS: Scenario[] = [
  {
    name: 'two-hop vendor chain',
    facts: [
      'The invoice INV-4471 was approved by Ratna Wibowo, who leads the procurement desk.',
      'Ratna Wibowo authorized the emergency purchase from PT Sinar Abadi for the defective batch B-2291.',
    ],
    question: 'Which vendor supplied the defective batch that Ratna Wibowo approved the purchase from?',
    expected: 'Sinar Abadi',
    distractor: 'INV-4471',
    reasoning: 'Approver -> purchase -> vendor. Neither fact names the vendor as the defective-batch supplier alone.',
  },
  {
    name: 'org-chart hop',
    facts: [
      'Bayu Nugroho reports directly to Clara Handayani in the finance division.',
      'Clara Handayani signed off on the Q3 budget reallocation for the Jakarta warehouse.',
    ],
    question: "Who is the manager that approved the Jakarta warehouse's Q3 budget reallocation?",
    expected: 'Clara Handayani',
    distractor: 'Bayu Nugroho',
    reasoning: 'Report -> manager -> approval. The distractor is the reporter, the tempting wrong answer.',
  },
  {
    name: 'shared-vendor hop',
    facts: [
      'PT Cahaya Timur delivered the raw materials for project Alpha in March.',
      'PT Cahaya Timur was flagged in the audit for late deliveries to project Beta.',
    ],
    question: 'Which project was affected by the audit finding about late deliveries from the project Alpha materials supplier?',
    expected: 'Beta',
    distractor: 'Alpha',
    reasoning: 'Supplier -> audit finding -> OTHER project. The question deliberately says "Alpha" to bait a same-chunk answer.',
  },
]

/**
 * FILLER facts, written to the SAME dataset as the scenarios.
 *
 * WHY: on the first live run the three scenarios wrote 6 items and every recall
 * returned exactly 6 chunks — i.e. CHUNKS handed back the whole dataset, so a
 * "hit" proved nothing about traversal. The probe was unfalsifiable. Filling the
 * dataset with unrelated-but-plausible procurement facts means "return
 * everything" can no longer score 100%: the answer now has to be RANKED into the
 * top-K ahead of distractors that share vocabulary with the question.
 *
 * The filler deliberately reuses the same domain vocabulary (invoice, vendor,
 * batch, approval) so a keyword-overlap retriever has to actually
 * discriminate rather than win on topic words alone.
 */
const FILLER: string[] = [
  'The invoice INV-8802 was approved by Hendra Kusuma, who leads the logistics desk.',
  'PT Bumi Sentosa authorized the emergency purchase for the surplus batch C-5510.',
  'Dewi Lestari reports directly to Fajar Ramadhan in the operations division.',
  'Fajar Ramadhan signed off on the Q2 budget reallocation for the Surabaya warehouse.',
  'PT Delta Prima delivered the raw materials for project Gamma in April.',
  'PT Delta Prima was flagged in the audit for late deliveries to project Delta.',
  'The invoice INV-3390 was approved by Hendra Kusuma for the defective batch D-7712.',
  'PT Sinar Abadi was praised in the audit for on-time deliveries to project Epsilon.',
  'Gita Permata reports directly to Clara Handayani in the finance division.',
  'Bayu Nugroho signed off on the Q4 budget reallocation for the Bandung warehouse.',
]

interface Outcome {
  scenario: string
  hit: boolean
  /** 1-based position of the first hit containing the expected token, 0 = absent. */
  rank: number
  latencyMs: number
  returned: string
  chunks: number
  /** Where the server says the chunk came from ('graph' | 'vector' | ...). */
  sources: string[]
}

/**
 * A CROSS question: a real question from the corpus, pointed at a dataset that
 * does NOT contain its answer. If the system returns the expected token for a
 * question whose facts were never written, the probe is measuring "return
 * everything" rather than retrieval, and every HIT above is worthless.
 *
 * This control is the reason the probe is worth running. On the first live run
 * every scenario ALSO returned its distractor, which is exactly the shape you
 * would see if CHUNKS simply handed back the whole (tiny) dataset — so the raw
 * 100% was not interpretable. A control makes that failure observable.
 */
const CROSS_CONTROL = {
  name: 'control: unanswerable question',
  question: 'Which vendor supplied the defective batch that Ratna Wibowo approved the purchase from?',
  mustNotContain: 'Sinar Abadi',
}

async function main() {
  const opts = { baseUrl: BASE, timeoutMs: 240_000 }

  const version = await cogneeServerVersion(opts)
  console.log(`cognee server ${BASE} — version ${version}`)
  if (!version) {
    console.error('Server unreachable. Start it before running the probe.')
    process.exit(1)
  }
  console.log(`datasets before: ${JSON.stringify(await cogneeListDatasets(opts))}\n`)

  // --- WRITE. One remember call per scenario, 2 facts each. -------------------
  console.log('--- WRITE ---')
  // Filler first, in one call, so it lands in the same dataset BEFORE the
  // scenarios. See the FILLER note: without enough unrelated material the
  // dataset is so small that "return everything" scores 100%.
  const fRes = await cogneeRemember(opts, {
    texts: FILLER,
    datasetName: DATASET,
    runInBackground: false,
  })
  console.log(`  ${fRes && !fRes.error ? 'ok  ' : 'FAIL'} filler (${FILLER.length} facts)  status=${fRes?.status ?? '(null)'} items=${fRes?.items_processed ?? '-'}`)

  for (const s of SCENARIOS) {
    const t0 = Date.now()
    const res = await cogneeRemember(opts, {
      // One raw_data entry per fact: separate strings give the extractor two
      // documents to link across, rather than one paragraph it may summarize as
      // a single unit (which would not exercise the graph at all).
      texts: [s.facts[0], s.facts[1]],
      datasetName: DATASET,
      runInBackground: false,
    })
    const ms = Date.now() - t0
    // Judge a write by the store, never by `status` alone — that is exactly how
    // the rejected 0.2.0 binding passed a shallow check while losing data.
    const ok = !!res && !res.error
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${s.name.padEnd(22)} ${ms}ms  status=${res?.status ?? '(null)'} items=${res?.items_processed ?? '-'}`,
    )
  }
  console.log(`\ndatasets after: ${JSON.stringify(await cogneeListDatasets(opts))}\n`)

  // --- RECALL. The question is asked with NO session id: nothing here may -----
  // lean on conversational memory, only on what was actually stored.
  console.log('--- RECALL (multi-hop) ---')
  const outcomes: Outcome[] = []
  for (const s of SCENARIOS) {
    const t0 = Date.now()
    const hits = await cogneeRecall(opts, {
      query: s.question,
      datasets: [DATASET],
      searchType: 'CHUNKS',
      topK: 8,
    })
    const ms = Date.now() - t0
    const text = (hits ?? []).map((h) => h.text ?? '').join('\n')
    // RANK is the discriminating measure. "Present somewhere in the top-K" is
    // weak on a small corpus; "ranked FIRST, above a decoy that shares the
    // question's vocabulary" is a claim the graph has to earn.
    const rank = (hits ?? []).findIndex((h) => (h.text ?? '').includes(s.expected)) + 1
    const hit = rank > 0
    const sources = (hits ?? []).map((h) => String(h.source ?? '?'))
    outcomes.push({ scenario: s.name, hit, rank, latencyMs: ms, returned: text, chunks: (hits ?? []).length, sources })
    console.log(`\n  [${hit ? 'HIT ' : 'MISS'}] ${s.name}  (${ms}ms, ${(hits ?? []).length} chunks)`)
    console.log(`        question : ${s.question}`)
    console.log(`        needs    : ${s.reasoning}`)
    console.log(`        expected : "${s.expected}"   distractor: "${s.distractor}"`)
    console.log(`        rank of expected chunk: ${hit ? `#${rank}` : 'ABSENT'}${hit && rank === 1 ? ' (top result)' : ''}`)
    console.log(`        hit sources: ${sources.join(', ') || '(none)'}`)
    if (!hit) {
      const sawDistractor = text.includes(s.distractor)
      console.log(`        GOT THE DISTRACTOR instead ("${s.distractor}") — a one-hop answer.`)
      console.log(`        returned : ${text.slice(0, 400).replace(/\n/g, ' / ') || '(empty)'}`)
    } else if (text.includes(s.distractor)) {
      // Both present: retrieval found the right link but did not RANK it apart
      // from the decoy. Worth reporting separately from a clean hit.
      console.log(`        (also returned the distractor "${s.distractor}" — hit, but not disambiguated)`)
    }
  }

  // --- CONTROL. Ask a real question against an empty dataset. ----------------
  // Without this, "everything was returned" and "the graph traversed correctly"
  // look identical in the per-scenario output above.
  console.log('\n--- CONTROL (must MISS) ---')
  const emptyDataset = `${DATASET}:empty`
  const ct0 = Date.now()
  const cHits = await cogneeRecall(opts, {
    query: CROSS_CONTROL.question,
    datasets: [emptyDataset],
    searchType: 'CHUNKS',
    topK: 8,
  })
  const cMs = Date.now() - ct0
  const cText = (cHits ?? []).map((h) => h.text ?? '').join('\n')
  const controlLeaked = cText.includes(CROSS_CONTROL.mustNotContain)
  console.log(`  [${controlLeaked ? 'LEAK' : 'ok  '}] ${CROSS_CONTROL.name} (${cMs}ms, ${(cHits ?? []).length} chunks)`)
  console.log(`        asked a question about "${CROSS_CONTROL.mustNotContain}" in dataset "${emptyDataset}"`)
  if (controlLeaked) {
    console.log('        FAILED: it answered from a dataset that never held those facts.')
    console.log('        => retrieval is NOT dataset-scoped, and the scores above are unreliable.')
  } else {
    console.log('        good: nothing leaked across the dataset boundary.')
  }

  // --- SUMMARY ---------------------------------------------------------------
  const hits = outcomes.filter((o) => o.hit).length
  const pct = (hits / outcomes.length) * 100
  const lat = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b)
  console.log('\n=== MULTI-HOP RETRIEVAL SCORE ===')
  console.log(`  ${hits}/${outcomes.length} = ${pct.toFixed(1)}%`)
  console.log(`  recall latency: min ${lat[0]}ms · median ${lat[Math.floor(lat.length / 2)]}ms · max ${lat[lat.length - 1]}ms`)

  // A hit is only EVIDENCE of graph traversal if the decoy did not come along
  // for the ride. When every hit drags its distractor in, the likely mechanism is
  // that CHUNKS returned most/all of a tiny dataset — which is not traversal.
  const withDistractor = outcomes.filter((o) => {
    const s = SCENARIOS.find((x) => x.name === o.scenario)!
    return o.hit && o.returned.includes(s.distractor)
  }).length
  const avgChunks = outcomes.reduce((a, o) => a + o.chunks, 0) / outcomes.length
  const topRanked = outcomes.filter((o) => o.rank === 1).length
  const graphSourced = outcomes.filter((o) => o.sources.includes('graph')).length
  console.log(`  ranked #1 (above the decoy): ${topRanked}/${outcomes.length}`)
  console.log(`  hits that ALSO returned their distractor: ${withDistractor}/${hits}`)
  console.log(`  questions whose hits came from the GRAPH: ${graphSourced}/${outcomes.length}`)
  console.log(`  avg chunks returned per question: ${avgChunks.toFixed(1)}`)

  // The strongest claim this probe can support: the answer chunk was RANKED
  // FIRST, in a corpus large enough that returning everything is impossible, and
  // it beat a decoy sharing the question's vocabulary.
  if (topRanked === outcomes.length && outcomes.length > 0) {
    console.log('\n  STRONGEST SUPPORTED CLAIM: every answer chunk ranked #1, in a corpus')
    console.log('  where "return everything" cannot score 100%. That is evidence of ranking,')
    console.log('  not merely of storage — but still only about RETRIEVAL.')
  }
  if (hits > 0 && withDistractor === hits) {
    console.log('\n  NOTE: every hit came back alongside its decoy. On a corpus this small the')
    console.log('  distractor is expected to survive a top-8 window; what matters is that the')
    console.log('  answer outranked it. Re-run on a customer-sized corpus before generalizing.')
  }
  console.log('\n  SCOPE: retrieval recall only. This is NOT answer accuracy — a hit')
  console.log('  means the joined evidence was retrievable, not that the final reply used it.')
  if (controlLeaked) {
    console.log('\n  INVALID: the control leaked, so the score above is not a measurement.')
  }
  if (hits < outcomes.length) {
    console.log('\n  MISSES ARE THE FINDING, not a flake to re-run away. Each one printed')
    console.log('  what the store actually returned; read it before drawing a conclusion.')
  }
}

main().catch((e) => {
  console.error('probe failed:', e)
  process.exit(1)
})
