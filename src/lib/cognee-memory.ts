/**
 * Cognee — chat memory: remember/recall + session-level semantic cache.
 * Depends on: cognee-types, cognee-core.
 */
import type { ChatTurnMemory } from './cognee-types'
import { datasetFor } from './cognee-types'
import { isCogneeEnabled, getCogneeClient, getCogneeOwnerId, formatSearchResponse } from './cognee-core'

export async function rememberChatTurn(args: ChatTurnMemory): Promise<void> {
  if (!(await isCogneeEnabled())) return
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

    await c.remember(
      [{ type: 'text', text }],
      datasetFor(),
    )
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
  const c = await getCogneeClient()
  if (!c) return ''

  // ponytail: check session cache first — avoids cognee round-trip for repeat questions
  if (args.sessionId) {
    const cached = getCachedRecall(args.sessionId, args.query)
    if (cached !== null) return cached
  }

  const graphResult = await recallFromGraph(c, args.query)
  const sessionResult = args.sessionId
    ? await recallFromSession(c, args.query, args.sessionId)
    : ''

  const merged = [sessionResult, graphResult].filter(Boolean).join('\n')

  if (args.sessionId && merged) {
    setCachedRecall(args.sessionId, args.query, merged)
  }

  return merged
}

async function recallFromGraph(c: any, query: string): Promise<string> {
  // ponytail: guard against "dataset not found" noise — a fresh org (or one
  // whose cognify jobs are still queued) has no dataset yet, and every search
  // against a missing dataset throws a runtime error that used to spam the log
  // twice per chat turn. has() is a cheap metadata lookup.
  const ds = datasetFor()
  try {
    const exists = await c.datasets?.has?.(ds)
    if (exists === false) return ''
  } catch {
    // datasets.has unavailable in older SDK — fall through and let search decide
  }

  // ponytail: only SearchType values the cognee-ts SDK actually serializes.
  // GRAPH_ENTITIES/GRAPH_RELATIONSHIPS were never valid — the Rust side rejects
  // them with "unknown SearchType" validation errors (they came from a Python
  // cognee version we never shipped). SUMMARIES→CHUNKS is the graph-grounded
  // pair; NATURAL_LANGUAGE (graph→Cypher) covers entity/relationship questions.
  const strategies = [
    { searchType: 'SUMMARIES', topK: 5 },
    { searchType: 'CHUNKS', topK: 5 },
    { searchType: 'NATURAL_LANGUAGE', topK: 10 },
  ]
  const results: string[] = []
  for (const strategy of strategies) {
    try {
      const result = await c.search(query, {
        datasets: [datasetFor()],
        topK: strategy.topK,
        searchType: strategy.searchType,
        userId: getCogneeOwnerId(),
      })
      const formatted = formatSearchResponse(result)
      if (formatted) results.push(formatted)
    } catch (e) {
      console.warn('[cognee] graph recall strategy failed:', e instanceof Error ? e.message : String(e))
    }
  }
  if (results.length > 0) return dedupeJoin(results)
  // Last resort: no dataset filter
  try {
    const result = await c.search(query, { topK: 5, userId: getCogneeOwnerId() })
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
    const result = await c.search(query, {
      sessionId,
      topK: 3,
      userId: getCogneeOwnerId(),
    })
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
