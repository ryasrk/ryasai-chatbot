/**
 * Cognee — chat memory: remember/recall + session-level semantic cache.
 * Depends on: cognee-types, cognee-core.
 */
import type { ChatTurnMemory } from './cognee-types'
import { datasetFor } from './cognee-types'
import { MEMORY_CONTEXT_MAX_CHARS } from '@/lib/constants'
import { isCogneeEnabled, getCogneeClient, getCogneeOwnerId, formatSearchResponse, withDeadline, getCogneeGraphProvider, supportsNaturalLanguageSearch, getCogneeServerOptions } from './cognee-core'
import { cogneeRemember, cogneeRecall } from './cognee-http'

export async function rememberChatTurn(args: ChatTurnMemory): Promise<void> {
  if (!(await isCogneeEnabled())) return

  // Server backend: one HTTP call, and the SERVER decides when the pipeline has
  // run. `runInBackground: false` is deliberate — a backgrounded write returns
  // before the data is searchable, which would make the very next turn's recall
  // miss a fact we just "stored".
  const serverOpts = await getCogneeServerOptions()
  if (serverOpts) {
    // ponytail: graceful degradation — fire-and-forget, memory loss is never fatal
    try {
      const text = JSON.stringify({
        type: 'chat_turn',
        user: args.userMessage,
        assistant: args.aiMessage,
        tools: args.toolRuns,
        sessionId: args.sessionId,
        ts: Date.now(),
      })
      const res = await cogneeRemember(serverOpts, {
        texts: [text],
        datasetName: datasetFor(),
        runInBackground: false,
      })
      if (!res) {
        console.warn('[cognee] remember failed: server unreachable or rejected the write')
      } else if (res.error) {
        console.warn('[cognee] remember failed:', res.error)
      }
    } catch (err) {
      console.warn('[cognee] remember failed:', err)
    }
    return
  }

  const c = await getCogneeClient()
  if (!c) return
  // ponytail: graceful degradation — fire-and-forget, swallows errors when cognee SDK fails
  try {
    const text = JSON.stringify({
      type: 'chat_turn',
      user: args.userMessage,
      assistant: args.aiMessage,
      tools: args.toolRuns,
      sessionId: args.sessionId,
      ts: Date.now(),
    })

    // Bounded: this runs AFTER the answer is computed, so an SDK that never settles would
    // hold the user's response open with nothing left to do. See withDeadline's comment.
    await withDeadline(c.remember([{ type: 'text', text }], datasetFor()), 'remember')
  } catch (err) {
    console.warn('[cognee] remember failed:', err)
  }
}

// ---------------------------------------------------------------------------
// Session-level semantic cache — avoids re-querying cognee for repeat questions
// in the same session. ponytail: in-memory Map with TTL, per-instance not distributed.
// Ceiling: cleared on server restart. Upgrade to Redis-backed cache if needed.
// ---------------------------------------------------------------------------

const SESSION_CACHE_TTL = 60000 // 1 minute
const SESSION_CACHE_MAX = 100 // max entries per session
const _sessionCache = new Map<string, Map<string, { result: string; ts: number }>>()

function sessionCacheKey(query: string): string {
  // ponytail: simple hash — query is short, crypto is overkill
  return query.slice(0, 200).toLowerCase().trim()
}

function getSessionCache(sessionId: string): Map<string, { result: string; ts: number }> {
  let cache = _sessionCache.get(sessionId)
  if (!cache) {
    cache = new Map()
    _sessionCache.set(sessionId, cache)
  }
  return cache
}

function getCachedRecall(sessionId: string, query: string): string | null {
  const cache = getSessionCache(sessionId)
  const key = sessionCacheKey(query)
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > SESSION_CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return entry.result
}

function setCachedRecall(sessionId: string, query: string, result: string): void {
  const cache = getSessionCache(sessionId)
  const key = sessionCacheKey(query)
  // ponytail: evict oldest when at capacity (Map preserves insertion order)
  if (cache.size >= SESSION_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
  cache.set(key, { result, ts: Date.now() })
}

/** Clear the session cache — call when a session is deleted. */
export function clearSessionCache(sessionId?: string): void {
  if (sessionId) _sessionCache.delete(sessionId)
  else _sessionCache.clear()
}

// ---------------------------------------------------------------------------
// Recall (graph + session)
// ---------------------------------------------------------------------------

export async function recallContext(args: {
  query: string
  sessionId?: string
}): Promise<string> {
  if (!(await isCogneeEnabled())) return ''

  // ponytail: check session cache first — avoids cognee round-trip for repeat questions
  if (args.sessionId) {
    const cached = getCachedRecall(args.sessionId, args.query)
    if (cached !== null) return cached
  }

  const serverOpts = await getCogneeServerOptions()
  if (serverOpts) {
    const merged = capMemory(await recallFromServer(serverOpts, args.query, args.sessionId))
    if (args.sessionId && merged) setCachedRecall(args.sessionId, args.query, merged)
    return merged
  }

  const c = await getCogneeClient()
  if (!c) return ''

  const graphResult = await recallFromGraph(c, args.query)
  const sessionResult = args.sessionId
    ? await recallFromSession(c, args.query, args.sessionId)
    : ''

  const merged = capMemory([sessionResult, graphResult].filter(Boolean).join('\n'))

  if (args.sessionId && merged) {
    setCachedRecall(args.sessionId, args.query, merged)
  }

  return merged
}

/**
 * Recall through a cognee 1.5.4 server.
 *
 * MEASURED on two stored facts: `CHUNKS` and `SUMMARIES` each return the stored
 * items as separate hits, while `HYBRID_COMPLETION` (the server default) returns
 * ONE LLM-synthesized answer with a single `text` field. Both facts were present
 * inside that one answer, so its `results.length` is NOT a recall count.
 *
 * That matters for this caller: the output is injected as MEMORY CONTEXT for the
 * router/SQL/answer prompts, where losing an individual fact is worse than a
 * slightly less fluent blob. So CHUNKS + SUMMARIES are the strategies here, and
 * HYBRID_COMPLETION is deliberately not used — it would spend an LLM call to
 * re-word facts we then paste into a second LLM prompt.
 */
async function recallFromServer(
  opts: import('./cognee-http').CogneeHttpOptions,
  query: string,
  sessionId?: string,
): Promise<string> {
  const dataset = datasetFor()
  const strategies: Array<{ searchType: string; topK: number }> = [
    { searchType: 'SUMMARIES', topK: 5 },
    { searchType: 'CHUNKS', topK: 5 },
  ]

  const parts: string[] = []
  for (const strategy of strategies) {
    try {
      const hits = await cogneeRecall(opts, {
        query,
        datasets: [dataset],
        searchType: strategy.searchType,
        topK: strategy.topK,
        sessionId,
      })
      if (!hits?.length) continue
      const text = hits.map((h) => h.text ?? '').filter(Boolean).join('\n')
      if (text) parts.push(text)
    } catch (e) {
      console.warn('[cognee] server recall strategy failed:', e instanceof Error ? e.message : String(e))
    }
  }

  return parts.length > 0 ? dedupeJoin(parts) : ''
}

/**
 * Bound the memory block before it reaches a prompt.
 *
 * Both recall strategies are merged with an unbounded `join`, and the result is interpolated
 * into up to six prompts per turn — so a large dataset could push the user's actual question
 * out of the window. Sibling context sources are already capped (`buildSourceGuidance`, 2000),
 * which made memory the only unbounded injection path. Truncation keeps the HEAD: results are
 * appended in relevance order, so the most relevant memory survives and the marker makes the
 * loss visible to the model rather than silently dropping context.
 */
function capMemory(text: string): string {
  if (text.length <= MEMORY_CONTEXT_MAX_CHARS) return text
  return `${text.slice(0, MEMORY_CONTEXT_MAX_CHARS)}\n[memory truncated]`
}

async function recallFromGraph(c: any, query: string): Promise<string> {
  // ponytail: guard against "dataset not found" noise — a fresh org (or one
  // whose cognify jobs are still queued) has no dataset yet, and every search
  // against a missing dataset throws a runtime error that used to spam the log
  // twice per chat turn. has() is a cheap metadata lookup.
  // INCIDENT (measured on @cognee/cognee-ts 0.1.3): `datasets.has()` is NOT trustworthy.
  // A store that provably contained the fact — `datasets.list()` showed
  // `{name: 'org:<id>'}` and a raw `search()` returned the stored text — still answered
  // has('org:<id>') === false. Because this guard treated `false` as authoritative and
  // returned '' before searching, recall was silently and PERMANENTLY dead for that org:
  // the memory was written, stored, and retrievable, and the chatbot never saw it. That is
  // the worst possible failure for a layer we are making the core of memory — no error, no
  // log, just a bot that forgot everything.
  //
  // The guard's original purpose was only to suppress "dataset not found" log noise for a
  // genuinely fresh org, and a wasted search already degrades gracefully (each strategy is
  // isolated and the catch below returns ''). So `false` is now ADVISORY: it logs a warning
  // and every strategy still runs. Suppressing the graph strategies but keeping only the
  // session leg was the first attempt and was still wrong — the stored fact was reachable
  // through SUMMARIES/CHUNKS (measured: 113 and 187 chars), so the graph legs ARE the ones
  // that answer these questions. Only a search can tell you whether a dataset is usable.
  const ds = datasetFor()
  let datasetReportedMissing = false
  try {
    const exists = await c.datasets?.has?.(ds)
    if (exists === false) datasetReportedMissing = true
  } catch {
    // datasets.has unavailable in older SDK — fall through and let search decide
  }
  if (datasetReportedMissing) {
    console.warn(
      '[cognee] datasets.has() reported the org dataset as missing, but recall will still try ' +
        '(has() is unreliable in cognee-ts 0.1.3 — see the note above). dataset=' + ds,
    )
  }

  // ponytail: only SearchType values the cognee-ts SDK actually serializes.
  // GRAPH_ENTITIES/GRAPH_RELATIONSHIPS were never valid — the Rust side rejects
  // them with "unknown SearchType" validation errors (they came from a Python
  // cognee version we never shipped). SUMMARIES→CHUNKS is the graph-grounded
  // pair; NATURAL_LANGUAGE (graph→Cypher) covers entity/relationship questions.
  // MEASURED: NATURAL_LANGUAGE failed on EVERY attempt in the live pipeline — the SDK accepts
  // the name but emits Cypher the local kuzu backend rejects ("invalid input: NATURAL_LANGUAGE
  // search generated Cypher that this graph backend rejected on all 3 attempt(s)", 6039ms plus
  // its own LLM call). It is a valid SearchType, so it is not deleted; it is GATED on the graph
  // backend, which the client already knows. On kuzu it is replaced by CHUNKS_LEXICAL, measured
  // WORKING there at 41ms. GRAPH_COMPLETION was measured as an alternative and rejected: it
  // failed after 193341ms (embedding HTTP error), far worse than the strategy it would replace.
  const provider = await getCogneeGraphProvider()
  const strategies = [
    { searchType: 'SUMMARIES', topK: 5 },
    { searchType: 'CHUNKS', topK: 5 },
    ...(supportsNaturalLanguageSearch(provider)
      ? [{ searchType: 'NATURAL_LANGUAGE', topK: 10 }]
      : [{ searchType: 'CHUNKS_LEXICAL', topK: 10 }]),
  ]
  const results: string[] = []
  for (const strategy of strategies) {
    try {
      const result = await withDeadline(
        c.search(query, {
          datasets: [datasetFor()],
          topK: strategy.topK,
          searchType: strategy.searchType,
          userId: getCogneeOwnerId(),
        }),
        'recall-search',
      )
      const formatted = formatSearchResponse(result)
      if (formatted) results.push(formatted)
    } catch (e) {
      console.warn('[cognee] graph recall strategy failed:', e instanceof Error ? e.message : String(e))
    }
  }
  if (results.length > 0) return dedupeJoin(results)
  // Last resort: no dataset filter
  try {
    const result = await withDeadline(c.search(query, { topK: 5, userId: getCogneeOwnerId() }), 'recall-fallback')
    return formatSearchResponse(result)
  } catch (e) {
    console.warn('[cognee] graph recall failed:', e instanceof Error ? e.message : String(e))
    return ''
  }
}

/** Dedupe overlapping strategy outputs before joining — mirrors the KB recall path. */
function dedupeJoin(results: string[]): string {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const r of results) {
    const key = r.slice(0, 100)
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(r)
    }
  }
  return deduped.join('\n')
}

async function recallFromSession(c: any, query: string, sessionId: string): Promise<string> {
  // ponytail: graceful degradation — falls back to empty string when cognee session search fails
  try {
    const result = await withDeadline(
      c.search(query, {
        sessionId,
        topK: 3,
        userId: getCogneeOwnerId(),
      }),
      'recall-session',
    )
    return formatSearchResponse(result)
  } catch (e) {
    // Session search without any session history is expected pre-first-cognify;
    // only warn when it's not the known missing-dataset/no-history shapes.
    const msg = e instanceof Error ? e.message : String(e)
    if (!/dataset not found|no (session|history|qa)/i.test(msg)) {
      console.warn('[cognee] session recall failed:', msg)
    }
    return ''
  }
}
