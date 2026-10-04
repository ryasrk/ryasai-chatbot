/**
 * Cognee HTTP client — talks to a cognee API server (pinned v1.6.0).
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
 * cache. Document writes delegate persisted phase waiting to cognee-document-pipeline.ts.
 * Settings live in cognee-core.ts so the
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

import { processDocumentPipeline, type DocumentPipelineWait } from './cognee-document-pipeline'

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

/** One dependency the sidecar reports on, as `/health/detailed` describes it. */
export interface CogneeComponentStatus {
  /** e.g. `relational_db`, `llm_provider`, `embedding_service`. */
  name: string
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
  /** Provider the sidecar selected, when it names one (`sqlite`, `kuzu`, `openai`…). */
  provider: string | null
  /** Human-readable reason. On a failure this is the ACTIONABLE part. */
  details: string | null
  responseTimeMs: number | null
}

export interface CogneeDiagnostics {
  /** The sidecar's own overall verdict: `healthy`, `degraded`, … */
  status: string
  version: string | null
  uptimeSeconds: number | null
  components: CogneeComponentStatus[]
}

/**
 * Read `/health/detailed` from the sidecar.
 *
 * WHY THIS EXISTS, and why a single "connected" boolean was not enough.
 *
 * `/health` answers "is the process up" and nothing else. The failure this project actually hit on a
 * live install is invisible to it: cognee reported `{"status":"ready","health":"healthy"}` while
 * EVERY memory write failed, because `LLM_API_KEY` was unset and the graph extension path was
 * missing. An admin seeing a green badge had nothing to act on — the product said "healthy" and
 * stored nothing.
 *
 * `/health/detailed` names each dependency and, on failure, carries the fix in `details`
 * (measured on a real deployment):
 *
 *   llm_provider      degraded  "LLMAPIKeyNotSetError: LLM API key is not set. … Set LLM_API_KEY"
 *   embedding_service degraded  "Embedding connection test timed out after 30s. … Set
 *                                COGNEE_SKIP_CONNECTION_TEST=true to bypass this check."
 *
 * That text is the whole reason this function exists: it is what turns a red badge into an action.
 *
 * `embedding_service: degraded` WAS called a false alarm in an earlier revision of this comment, on
 * the evidence that a direct embedding call from the same container succeeded. THAT CONCLUSION WAS
 * WRONG, and the retraction matters more than the original claim: a direct `curl` bypasses litellm,
 * and litellm is precisely where the failure lives. Measured by calling litellm the way the server
 * does (`litellm.embedding(...)` inside the sidecar):
 *
 *     model="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
 *       -> BadRequestError: "LLM Provider NOT provided"    (0.0s — provider unparsable)
 *     model="openai/paraphrase-multilingual-MiniLM-L12-v2"
 *       -> OK, dim=384                                     (0.7s)
 *
 * litellm reads the text before the slash as a PROVIDER name, so a bare model id is parsed as a
 * provider that does not exist and the request never leaves the process. The endpoint's own access
 * log showed ZERO calls while `/health/detailed` timed out after 30s.
 *
 * So the warning was real, and "the endpoint answers a direct call" was never evidence that cognee
 * could reach it. Keep this note: the tempting shortcut is exactly the one that hid the bug.
 *
 * Returns null when the server is unreachable, so callers show "unknown" rather than inventing a
 * verdict.
 */
export async function cogneeServerDiagnostics(
  opts: CogneeHttpOptions,
): Promise<CogneeDiagnostics | null> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/health/detailed`
  /*
   * DEADLINE IS DELIBERATELY SHORTER THAN THE SERVER'S WORST CASE.
   *
   * This endpoint actively tests each dependency and the embedding probe alone budgets 30s, so a
   * misconfigured sidecar answers in 30.2s — MEASURED. The AI Memory card awaits this call before it
   * renders anything, so that 30s is the "stuck loading" a user sees. A 45s deadline (the previous
   * value) also meant the request could outlive the page's own patience.
   *
   * 8s is enough for a healthy sidecar: measured 0.0s when all components are up. A sidecar that
   * cannot answer in 8s gets `null`, and the UI says "not reachable" — which is HONEST for a
   * component that is answering 30s late, and far more useful than a spinner. The slow answer is
   * still diagnosed by whatever made it slow; the panel's job is not to wait for all of it.
   */
  const res = await fetchWithDeadline(url, { method: 'GET' }, opts.timeoutMs ?? 8000)
  if (!res) return null
  if (!res.ok && res.status !== 503) return null
  // 503 IS EXPECTED AND MUST BE PARSED, not treated as unreachable.
  //
  // MEASURED on the production sidecar: `/health/detailed` answers **HTTP 503** with a COMPLETE
  // body — `{"status":"degraded","components":{…6 components…}}`. The server uses the status code as
  // its verdict and the body as the explanation. A `res.ok` check therefore returned `null` in
  // exactly the situation this endpoint exists for, and the UI would have shown nothing at the
  // moment an operator needed it most. A hard failure (500, 404, HTML error page) still returns null
  // below, because the JSON parse fails.
  try {
    const body = (await res.json()) as {
      status?: string
      version?: string
      uptime?: number
      components?: Record<
        string,
        { status?: string; provider?: string; details?: string; response_time_ms?: number }
      >
    }
    const components: CogneeComponentStatus[] = Object.entries(body.components ?? {}).map(
      ([name, c]) => ({
        name,
        status: (['healthy', 'degraded', 'unhealthy'] as const).includes(
          c?.status as 'healthy',
        )
          ? (c.status as CogneeComponentStatus['status'])
          : 'unknown',
        provider: c?.provider ?? null,
        details: c?.details ?? null,
        responseTimeMs: typeof c?.response_time_ms === 'number' ? c.response_time_ms : null,
      }),
    )
    return {
      status: body.status ?? 'unknown',
      version: body.version ?? null,
      uptimeSeconds: typeof body.uptime === 'number' ? body.uptime : null,
      components,
    }
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
    waitForPipeline?: DocumentPipelineWait
  },
): Promise<CogneeRememberResult | null> {
  if (args.waitForPipeline) return processDocumentPipeline(opts, { ...args, wait: args.waitForPipeline })
  const form = new FormData()
  // The pinned server limits each multipart text field to 1 MiB. Use file
  // uploads for the entire batch if any text exceeds it, preserving entry order
  // because the server processes uploaded files before raw_data entries.
  const uploadTexts = args.texts.some(text => Buffer.byteLength(text, 'utf8') > 1_048_576)
  for (const [index, text] of args.texts.entries()) {
    if (uploadTexts) {
      form.append('data', new File([text], `document-${index}.txt`, { type: 'text/plain' }))
    } else {
      form.append('raw_data', text)
    }
  }
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
    /**
     * Restrict results to these node sets — the `node_set` values passed to `remember`.
     *
     * THIS IS THE ONLY WAY TO SCOPE A KNOWLEDGE-GRAPH READ. MEASURED need: a recall restricted to one
     * document still returned graph relations from OTHER documents, because the graph leg is a text
     * completion with no per-document metadata in its response — and `KgRelation` carries a `chunkId` but no
     * `documentId`, so nothing downstream could filter it either. Those relations reached the answer prompt
     * via `CONTEXT (KNOWLEDGE GRAPH)`, so a scoped API key could read another document's facts.
     *
     * Verified against cognee v1.6.0's own OpenAPI rather than assumed: the recall body's `node_name` is
     * documented as "Restrict results to these node sets (the node_set values passed to /v1/add or
     * /v1/remember). Omit to search all nodes."
     */
    nodeNames?: string[]
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
  // OMITTED when empty, never sent as an empty list: "no node sets" would restrict the search to nothing,
  // while an absent field means "all nodes" — the opposite meaning, and the correct default for the many
  // callers that do not scope.
  if (args.nodeNames && args.nodeNames.length > 0) payload.node_name = args.nodeNames

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
