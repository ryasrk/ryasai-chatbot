import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'

// ---------------------------------------------------------------------------
// cognee-http.ts is the transport for the cognee 1.5.4 server — the backend we
// now ship by default. It has no logic of its own to get "wrong" in an
// interesting way, so these tests are written against the things that actually
// cost debugging time against the live server:
//
//   1. `remember` MUST be multipart with a `raw_data` field per text. The server
//      rejects JSON with "Either datasetId or datasetName must be provided",
//      which reads like a missing dataset and is really a wrong content-type.
//   2. Every call must degrade to null/[] instead of throwing, because the
//      callers are fire-and-forget and a throw would surface as a failed chat
//      turn for what is only a missing memory.
//   3. A hung server must be abandoned at the deadline — the fetch must be
//      ABORTED, not merely raced, or the socket stays open.
//   4. `HYBRID_COMPLETION` returns one synthesized answer, so a test must not
//      assert on hit COUNT as if it were a recall count.
// ---------------------------------------------------------------------------

const fetchState = {
  calls: [] as Array<{ url: string; init: any }>,
  response: null as any,
  throws: false,
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  }
}

const realFetch = globalThis.fetch
function installFetchStub() {
  globalThis.fetch = (async (url: any, init: any) => {
    fetchState.calls.push({ url: String(url), init })
    if (fetchState.throws) throw new Error('ECONNREFUSED')
    return fetchState.response
  }) as any
}
installFetchStub()

const {
  cogneeServerReady,
  cogneeServerVersion,
  cogneeRemember,
  cogneeRecall,
  cogneeListDatasets,
  cogneeCognify,
  cogneeForget,
} = await import('./cognee-http')

const OPTS = { baseUrl: 'http://cognee:8000', timeoutMs: 1000 }

beforeEach(() => {
  fetchState.calls = []
  fetchState.response = jsonResponse({})
  fetchState.throws = false
  // Re-install per test: the deadline test replaces fetch with a never-settling
  // stub, so restoring only in afterEach would leave later tests unstubbed.
  installFetchStub()
})

afterEach(() => {
  // The module under test replaces nothing global itself; restore for other files.
  globalThis.fetch = realFetch
})

describe('cognee-http — health', () => {
  test('ready when the server reports status ready', async () => {
    fetchState.response = jsonResponse({ status: 'ready', health: 'healthy', version: '1.5.4' })
    expect(await cogneeServerReady(OPTS)).toBe(true)
    // /health is NOT under /api/v1 — that path difference is easy to get wrong.
    expect(fetchState.calls[0].url).toBe('http://cognee:8000/health')
  })

  test('ready also accepts the health field alone', async () => {
    fetchState.response = jsonResponse({ health: 'healthy' })
    expect(await cogneeServerReady(OPTS)).toBe(true)
  })

  test('not ready on a non-ready status', async () => {
    fetchState.response = jsonResponse({ status: 'starting' })
    expect(await cogneeServerReady(OPTS)).toBe(false)
  })

  test('unreachable server is not ready, and does not throw', async () => {
    fetchState.throws = true
    expect(await cogneeServerReady(OPTS)).toBe(false)
  })

  test('version is read from the health payload', async () => {
    fetchState.response = jsonResponse({ status: 'ready', version: '1.5.4' })
    expect(await cogneeServerVersion(OPTS)).toBe('1.5.4')
  })

  test('version is null when unreachable rather than throwing', async () => {
    fetchState.throws = true
    expect(await cogneeServerVersion(OPTS)).toBeNull()
  })
})

describe('cognee-http — remember (the write path)', () => {
  test('sends multipart with one raw_data field per text', async () => {
    fetchState.response = jsonResponse({ status: 'completed', items_processed: 2 })
    const res = await cogneeRemember(OPTS, {
      texts: ['first fact', 'second fact'],
      datasetName: 'org:acme',
    })

    const [call] = fetchState.calls
    expect(call.url).toBe('http://cognee:8000/api/v1/remember')
    expect(call.init.method).toBe('POST')

    // FormData, not a JSON body — the server rejects JSON here.
    const form = call.init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.getAll('raw_data')).toEqual(['first fact', 'second fact'])
    expect(form.get('datasetName')).toBe('org:acme')
  })

  test('does not set content-type, so the multipart boundary is generated', async () => {
    await cogneeRemember(OPTS, { texts: ['x'], datasetName: 'org:acme' })
    const headers = fetchState.calls[0].init.headers ?? {}
    expect(headers['content-type']).toBeUndefined()
  })

  test('passes run_in_background=false so the write completes before recall', async () => {
    await cogneeRemember(OPTS, { texts: ['x'], datasetName: 'org:acme', runInBackground: false })
    expect((fetchState.calls[0].init.body as FormData).get('run_in_background')).toBe('false')
  })

  test('returns the result body including the fields that prove a real write', async () => {
    fetchState.response = jsonResponse({
      status: 'completed',
      dataset_id: 'd-1',
      pipeline_run_id: 'p-1',
      items_processed: 1,
      elapsed_seconds: 19.9,
    })
    const res = await cogneeRemember(OPTS, { texts: ['x'], datasetName: 'org:acme' })
    expect(res?.status).toBe('completed')
    expect(res?.dataset_id).toBe('d-1')
    expect(res?.pipeline_run_id).toBe('p-1')
    expect(res?.items_processed).toBe(1)
  })

  test('a rejected write is surfaced as null, never a thrown error', async () => {
    fetchState.response = jsonResponse({ error: 'boom' }, false, 500)
    expect(await cogneeRemember(OPTS, { texts: ['x'], datasetName: 'org:acme' })).toBeNull()
  })

  test('an unreachable server degrades to null', async () => {
    fetchState.throws = true
    expect(await cogneeRemember(OPTS, { texts: ['x'], datasetName: 'org:acme' })).toBeNull()
  })
})

describe('cognee-http — recall (the read path)', () => {
  test('posts JSON to /recall with datasets by name', async () => {
    fetchState.response = jsonResponse([{ text: 'fact' }])
    await cogneeRecall(OPTS, { query: 'what?', datasets: ['org:acme'], topK: 7 })

    const [call] = fetchState.calls
    expect(call.url).toBe('http://cognee:8000/api/v1/recall')
    expect(call.init.headers['content-type']).toBe('application/json')
    const body = JSON.parse(call.init.body)
    expect(body.query).toBe('what?')
    expect(body.datasets).toEqual(['org:acme'])
    expect(body.topK).toBe(7)
  })

  test('forwards the searchType so callers can avoid HYBRID_COMPLETION', async () => {
    fetchState.response = jsonResponse([])
    await cogneeRecall(OPTS, { query: 'q', datasets: ['d'], searchType: 'CHUNKS' })
    expect(JSON.parse(fetchState.calls[0].init.body).searchType).toBe('CHUNKS')
  })

  test('omits searchType when the caller wants the server default', async () => {
    fetchState.response = jsonResponse([])
    await cogneeRecall(OPTS, { query: 'q', datasets: ['d'] })
    expect(JSON.parse(fetchState.calls[0].init.body).searchType).toBeUndefined()
  })

  test('returns every hit, so a caller can see both stored facts', async () => {
    fetchState.response = jsonResponse([
      { text: 'fact one', source: 'graph' },
      { text: 'fact two', source: 'graph' },
    ])
    const hits = await cogneeRecall(OPTS, { query: 'q', datasets: ['d'], searchType: 'CHUNKS' })
    expect(hits).toHaveLength(2)
    expect(hits?.map((h) => h.text)).toEqual(['fact one', 'fact two'])
  })

  test('an empty result set is an empty array, not null', async () => {
    fetchState.response = jsonResponse([])
    expect(await cogneeRecall(OPTS, { query: 'q', datasets: ['d'] })).toEqual([])
  })

  test('a failed recall degrades to null', async () => {
    fetchState.response = jsonResponse({ error: 'bad' }, false, 400)
    expect(await cogneeRecall(OPTS, { query: 'q', datasets: ['d'] })).toBeNull()
  })
})

describe('cognee-http — datasets and statements', () => {
  test('listDatasets extracts names from the array payload', async () => {
    fetchState.response = jsonResponse([{ name: 'org:acme' }, { name: 'org:acme:kb' }])
    expect(await cogneeListDatasets(OPTS)).toEqual(['org:acme', 'org:acme:kb'])
  })

  test('listDatasets tolerates a non-array payload instead of throwing', async () => {
    fetchState.response = jsonResponse({ unexpected: true })
    expect(await cogneeListDatasets(OPTS)).toEqual([])
  })

  test('listDatasets degrades to an empty list when unreachable', async () => {
    fetchState.throws = true
    expect(await cogneeListDatasets(OPTS)).toEqual([])
  })

  test('cognify posts the dataset name and reports success as a boolean', async () => {
    fetchState.response = jsonResponse({ status: 'completed' })
    expect(await cogneeCognify(OPTS, { datasetName: 'org:acme:kb' })).toBe(true)
    const body = JSON.parse(fetchState.calls[0].init.body)
    expect(body.datasets).toEqual(['org:acme:kb'])
  })

  test('cognify reports failure without throwing', async () => {
    fetchState.response = jsonResponse({}, false, 500)
    expect(await cogneeCognify(OPTS, { datasetName: 'd' })).toBe(false)
  })

  test('forget with everything=true is the GDPR reset shape', async () => {
    fetchState.response = jsonResponse({ ok: true })
    expect(await cogneeForget(OPTS, { everything: true })).toBe(true)
    expect(JSON.parse(fetchState.calls[0].init.body)).toEqual({ everything: true })
  })

  test('forget scoped to one dataset does not set everything', async () => {
    fetchState.response = jsonResponse({ ok: true })
    await cogneeForget(OPTS, { dataset: 'org:acme:kb' })
    const body = JSON.parse(fetchState.calls[0].init.body)
    expect(body.dataset).toBe('org:acme:kb')
    expect(body.everything).toBeUndefined()
  })
})

describe('cognee-http — deadlines and auth', () => {
  test('an auth key is sent as a bearer token when configured', async () => {
    fetchState.response = jsonResponse({})
    await cogneeForget({ ...OPTS, apiKey: 'secret' }, { everything: true })
    expect(fetchState.calls[0].init.headers.authorization).toBe('Bearer secret')
  })

  test('no authorization header is sent when no key is configured', async () => {
    fetchState.response = jsonResponse({})
    await cogneeForget(OPTS, { everything: true })
    expect(fetchState.calls[0].init.headers.authorization).toBeUndefined()
  })

  test('a trailing slash on baseUrl does not produce a double slash', async () => {
    fetchState.response = jsonResponse([])
    await cogneeListDatasets({ baseUrl: 'http://cognee:8000/' })
    expect(fetchState.calls[0].url).toBe('http://cognee:8000/api/v1/datasets')
  })

  test('a hung request is abandoned at the deadline instead of hanging the caller', async () => {
    // A fetch that never settles unless aborted — models a wedged server. The
    // implementation must ABORT (rejecting this promise), not merely race it.
    globalThis.fetch = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as any

    const started = Date.now()
    const res = await cogneeRecall({ baseUrl: 'http://cognee:8000', timeoutMs: 120 }, {
      query: 'q',
      datasets: ['d'],
    })
    const elapsed = Date.now() - started

    expect(res).toBeNull()
    // Bounded by the deadline, not by anything the server does.
    expect(elapsed).toBeLessThan(1000)
    globalThis.fetch = realFetch
  })
})
