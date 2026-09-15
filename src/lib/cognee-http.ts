/**
 * Cognee HTTP client — talks to a cognee API server (v1.5.4).
 * ----------------------------------------------------------------------------
 * Replaces the in-process `@cognee/cognee-ts` SDK. Why the server:
 *
 *   - The TS binding's latest release (0.2.0) reports success on `remember()`
 *     while writing nothing, then poisons the store permanently. See
 *     scripts/cognee-upgrade-check.md.
 *   - The Python server is the project's primary artifact and its write path is
 *     real: measured 19.9s for a write and 4.3s for a recall that returned the
 *     token (docs/cognee-http-migration.md).
 *
 * This module is a thin transport layer only — no tenant logic, no settings
 * cache, no retries beyond a deadline. Those live in cognee-core.ts so the
 * provider choice stays in one place.
 *
 * GRACEFUL DEGRADATION: every call returns null / [] rather than throwing when
 * the server is unreachable, so chat keeps working without memory (the same
 * contract the disabled in-process SDK had).
 *
 * CONTRACT NOTES (each measured against a live server, 2026-09-15):
 *   - POST /remember is multipart/form-data with `raw_data` (repeatable string),
 *     `datasetName`, `node_set`, `session_id`. JSON is rejected with
 *     "Either datasetId or datasetName must be provided."
 *   - POST /add takes FILE uploads only; text goes through /remember.
 *   - POST /recall and /search take JSON and accept `datasets` (names).
 *   - `datasets.has()` has no equivalent here — GET /datasets lists datasets
 *     truthfully, so the old advisory-only workaround is not ported.
 */

/** A single search hit as the server returns it (v1.5.4 shape). */
export interface CogneeSearchHit {
  kind?: string
  search_type?: string
  text?: string
  score?: number | null
  dataset_id?: string
  dataset_name?: string
  source?: string
  metadata?: Record<string, unknown>
  raw?: unknown
  structured?: unknown
}

export interface CogneeRememberResult {
  status?: string
  dataset_name?: string
  dataset_id?: string | null
  pipeline_run_id?: string | null
  items_processed?: number
  elapsed_seconds?: number
  error?: string | null
}

export interface CogneeHttpOptions {
  /** e.g. http://cognee:8000 — the origin only; /api/v1 is appended. */
  baseUrl: string
  /** Bounded per-request. The caller owns the overall budget. */
  timeoutMs?: number
  /** Sent as Bearer when the server runs with auth enabled. */
  apiKey?: string
}

const DEFAULT_TIMEOUT_MS = 30000

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/v1${path}`
}

/**
 * fetch with a hard deadline. Uses AbortController rather than Promise.race so
 * the socket is actually closed — a raced-but-live request keeps the connection
 * and the server's work slot occupied.
 */
async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch {
    // Unreachable, DNS failure, or aborted at the deadline. Degrade, don't throw.
    return null
  } finally {
    clearTimeout(timer)
  }
}

function headers(opts: CogneeHttpOptions, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {}
  if (contentType) h['content-type'] = contentType
  if (opts.apiKey) h.authorization = `Bearer ${opts.apiKey}`
  return h
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * True when the server answers /health with a ready status.
 *
 * The endpoint is NOT under /api/v1 and returns
 * {"status":"ready","health":"healthy","version":"1.5.4"}.
 */
export async function cogneeServerReady(opts: CogneeHttpOptions): Promise<boolean> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/health`
  const res = await fetchWithDeadline(url, { method: 'GET' }, opts.timeoutMs ?? 5000)
  if (!res || !res.ok) return false
  try {
    const body = (await res.json()) as { status?: string; health?: string }
    return body?.status === 'ready' || body?.health === 'healthy'
  } catch {
    return false
  }
}

/** The server's reported version, or null when unreachable. */
export async function cogneeServerVersion(opts: CogneeHttpOptions): Promise<string | null> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/health`
  const res = await fetchWithDeadline(url, { method: 'GET' }, opts.timeoutMs ?? 5000)
  if (!res || !res.ok) return null
  try {
    return ((await res.json()) as { version?: string })?.version ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Store text in a dataset. Runs the FULL cognify pipeline server-side, so a
 * real call takes 5-35s; a fast return is suspicious (see the 0.2.0 note above).
 *
 * Multipart, because that is what the endpoint accepts for text. `raw_data`
 * repeats once per text item.
 */
export async function cogneeRemember(
  opts: CogneeHttpOptions,
  args: {
    texts: string[]
    datasetName: string
    sessionId?: string
    nodeSet?: string[]
    /** false = wait for the pipeline, so the caller knows when data is searchable. */
    runInBackground?: boolean
    timeoutMs?: number
  },
): Promise<CogneeRememberResult | null> {
  const form = new FormData()
  for (const text of args.texts) form.append('raw_data', text)
  form.append('datasetName', args.datasetName)
  if (args.sessionId) form.append('session_id', args.sessionId)
  for (const n of args.nodeSet ?? []) form.append('node_set', n)
  if (args.runInBackground !== undefined) {
    form.append('run_in_background', String(args.runInBackground))
  }

  const res = await fetchWithDeadline(
    apiUrl(opts.baseUrl, '/remember'),
    { method: 'POST', headers: headers(opts), body: form },
    args.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as CogneeRememberResult
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Recall against one dataset.
 *
 * IMPORTANT: `HYBRID_COMPLETION` returns ONE LLM-synthesized answer, so
 * `hits.length` is not a recall count — both facts can live inside a single
 * `text`. Factual memory retrieval should use CHUNKS/SUMMARIES.
 */
export async function cogneeRecall(
  opts: CogneeHttpOptions,
  args: {
    query: string
    datasets: string[]
    /** Defaults to HYBRID_COMPLETION server-side; CHUNKS for factual recall. */
    searchType?: string
    topK?: number
    sessionId?: string
    onlyContext?: boolean
    /** Chat turns are short; a long recall must not stall the response. */
    timeoutMs?: number
  },
): Promise<CogneeSearchHit[] | null> {
  const payload: Record<string, unknown> = {
    query: args.query,
    datasets: args.datasets,
    topK: args.topK ?? 10,
  }
  if (args.searchType) payload.searchType = args.searchType
  if (args.sessionId) payload.sessionId = args.sessionId
  if (args.onlyContext !== undefined) payload.onlyContext = args.onlyContext

  const res = await fetchWithDeadline(
    apiUrl(opts.baseUrl, '/recall'),
    {
      method: 'POST',
      headers: headers(opts, 'application/json'),
      body: JSON.stringify(payload),
    },
    args.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as CogneeSearchHit[]
  } catch {
    return null
  }
}

/** Dataset names visible to this server (replaces the TS binding's lying has()). */
export async function cogneeListDatasets(opts: CogneeHttpOptions): Promise<string[]> {
  const res = await fetchWithDeadline(
    apiUrl(opts.baseUrl, '/datasets'),
    { method: 'GET', headers: headers(opts) },
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  if (!res || !res.ok) return []
  try {
    const body = (await res.json()) as Array<{ name?: string }>
    return (Array.isArray(body) ? body : []).map((d) => d?.name ?? '').filter(Boolean)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Cognify (documents)
// ---------------------------------------------------------------------------

/** Build the graph for a dataset that already has data added. */
export async function cogneeCognify(
  opts: CogneeHttpOptions,
  args: { datasetName: string; runInBackground?: boolean; timeoutMs?: number },
): Promise<boolean> {
  const res = await fetchWithDeadline(
    apiUrl(opts.baseUrl, '/cognify'),
    {
      method: 'POST',
      headers: headers(opts, 'application/json'),
      body: JSON.stringify({
        datasets: [args.datasetName],
        runInBackground: args.runInBackground ?? false,
      }),
    },
    args.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  return !!res && res.ok
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Forget data. `everything: true` is the GDPR reset path — it clears all
 * datasets, so callers must have already scoped the decision to one org.
 */
export async function cogneeForget(
  opts: CogneeHttpOptions,
  args: { dataset?: string; everything?: boolean; timeoutMs?: number },
): Promise<boolean> {
  const payload: Record<string, unknown> = {}
  if (args.dataset) payload.dataset = args.dataset
  if (args.everything) payload.everything = true

  const res = await fetchWithDeadline(
    apiUrl(opts.baseUrl, '/forget'),
    {
      method: 'POST',
      headers: headers(opts, 'application/json'),
      body: JSON.stringify(payload),
    },
    args.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  return !!res && res.ok
}
