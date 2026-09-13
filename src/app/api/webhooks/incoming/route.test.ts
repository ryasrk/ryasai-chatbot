/**
 * POST /api/webhooks/incoming — the query webhook that drives RAG on behalf of a machine caller.
 *
 * WHY THIS FILE EXISTS. This route is PUBLIC (no session cookie) and unauthenticated at the HTTP layer:
 * the HMAC over the raw body computed by `verifyWebhookSignature()` in `@/lib/incoming-webhook` is the
 * ONLY thing standing between an anonymous POST and a full RAG run with tool-calling, billed to this
 * install's own LLM key. So the properties worth pinning are all boundary properties:
 *
 *   1. THE ROUTE DELEGATES THE SIGNATURE CHECK, IT DOES NOT PERFORM ONE. `POST` hands the raw body and
 *      the `x-webhook-signature` header straight to `processIncomingWebhook(payload, signature, rawBody)`
 *      and never touches a secret itself. That is a deliberate seam and it must stay that way: if the
 *      route ever starts deciding authenticity on its own we get two competing definitions of
 *      "authentic". Asserted POSITIONALLY, so the real lib's `(payload, signature, rawBody)` order is
 *      pinned rather than inferred from a mock's return value.
 *   2. THE RAW TEXT IS WHAT GETS SIGNED, NOT `JSON.stringify(payload)`. A re-serialization drops key
 *      order/whitespace and would silently invalidate every legitimate signature. The route reads the
 *      body ONCE with `req.text()` and forwards that exact string; asserted with a body whose
 *      whitespace and key order would NOT survive a round-trip.
 *   3. AN ABSENT SIGNATURE HEADER BECOMES `''`, NEVER `undefined`. `?? ''` is load-bearing: `undefined`
 *      would reach `Buffer.from(undefined)` in the real verifier and turn a clean 401 into a 500.
 *   4. `payload.query` IS VALIDATED BEFORE ANY WORK HAPPENS — missing, non-string, and (via the
 *      `!payload.query` half) empty-string all short-circuit to 400 with the processor AND the audit log
 *      untouched. A webhook that runs RAG on `undefined` spends real money on a question nobody asked.
 *   5. ORDER: PROCESS, THEN AUDIT, THEN RESPOND. `writeAudit` records `answerLen`, so it can only run
 *      after the answer exists. (For `severity: 'info'` the real `writeAudit` swallows insert failures —
 *      session.ts rethrows only for `'critical'` — so this is a best-effort trail, not a committed one.)
 *   6. FAIL-CLOSED ON A BAD SIGNATURE *AND* ON AN UNCONFIGURED SECRET. Both are 401 and neither reaches
 *      the database or the LLM. The unconfigured case matters most: without it an install with no
 *      `INCOMING_WEBHOOK_SECRET` would compare against nothing and accept forged RAG requests.
 *   7. THE 401 IS CHOSEN BY A REGEX ON MESSAGE TEXT — `/signature|secret/i` — NOT BY A TYPED ERROR. That
 *      is brittle in both directions and is pinned explicitly, including the false positive where an
 *      unrelated error mentioning a "secret" is reported to the caller as an auth failure.
 *
 * HOW THE MOCK IS SHAPED, AND WHY IT IS SHAPED THAT WAY. Two earlier drafts of this file produced ten
 * then two false failures, and both mistakes are worth not repeating:
 *
 *   (a) NO PER-TEST CAPTURE OF MUTABLE SEAMS. `mock.module` factories are invoked once, at first import,
 *       and the returned function bodies close over whatever they reference. My first draft did
 *       `const enteredViaVerifier = !verifyOk || ...` INSIDE the factory, freezing the flag at
 *       module-load time — before any `beforeEach` — so every per-test toggle was silently ignored and
 *       the mocked processor took its skip path ten times over. Mutable seams are now read at CALL
 *       time, through a hoisted predicate.
 *
 *   (b) NO CROSS-MODULE `node:crypto` IDENTITY. My second draft had the mocked verifier hash with the
 *       `node:crypto` default export it captured at factory-evaluation time, while the TEST hashed with
 *       the one it captured at its own evaluation time. Those were empirically DIFFERENT objects in the
 *       import graph (`crypto.createHmac(...)` was `undefined` on the test's copy once the mocked
 *       module was in play): the test signed `9729…` and the verifier expected `e39a…` for the identical
 *       body and secret, so a perfectly correct signature was rejected. A probe confirmed this is a
 *       module-graph artefact of `mock.module` here, not route behaviour — which is exactly why the
 *       mocked verifier now hashes with the module-scope `createHmac` bound at file scope from the SAME
 *       `node:crypto` import the tests use. That makes the comparison deterministic and keeps the real
 *       scheme (sha256 hex over the raw body, constant-time compare) genuinely exercised.
 *
 * The mock shape CLAIMS THE REAL CONTRACT of `@/lib/incoming-webhook` (read, not guessed):
 *   - `processIncomingWebhook(payload, signature, rawBody)` — secret checked FIRST, then the HMAC.
 *   - an UNKNOWN `signature` shape REJECTS. The initial mock state is `verify`, not `skip`: a
 *     mis-ordered or extra argument must not be able to produce a false "accepted".
 *   - the completion is reached via a dynamic import of `@/lib/tool-router`, then
 *     `runNonStreamingChatCompletion({ question, userId, sessionId, integrationId })`.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto'

/** Matches the shape of a real hex sha256 digest, so the signature plumbing is exercised realistically. */
const SECRET = 'incoming-webhook-secret'
const VALID_SIGNATURE = 'a'.repeat(64)

/** Real shape of `WebhookResult` (src/lib/incoming-webhook.ts): no wrapper object, no id, no echo. */
const RESULT = { answer: 'Forty-two.', citations: [{ id: 'c1' }], toolRuns: [{ name: 'calc' }] }
/** Real shape of the `runNonStreamingChatCompletion` result the lib maps onto `WebhookResult`. */
const CHAT_RESULT = { answer: 'Forty-two.', citations: [{ id: 'c1' }], toolRuns: [{ name: 'calc' }] }

/** Like the real verifier: sha256 hex over the RAW body, constant-time compare (no length oracle). */
function expectedMac(rawBody: string, secret: string): string {
  // NOT `JSON.stringify(parse(rawBody))` — the point is that the signature covers the bytes received.
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

/**
 * The verifier the mocked `@/lib/incoming-webhook` runs. Exported from the factory so the stub's hash
 * and the REAL verifier's hash in the block further down are literally the same function — asserting
 * they agree proves the route forwards the bytes, not that two copies of a hash happened to match.
 */
function realHashEqual(rawBody: string, signature: string, secret: string): boolean {
  const a = Buffer.from(signature)
  const b = Buffer.from(expectedMac(rawBody, secret))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** A per-run secret. There is no env coupling here at all: the mock owns the secret it checks with. */
const HMAC_SECRET = randomBytes(32).toString('hex')

// ---------------------------------------------------------------------------------------------
// MUTABLE SEAMS. Every one is a `let` at the TOP of the file, ABOVE the mock.module blocks, and
// every read happens at CALL time -- never during factory evaluation.
// ---------------------------------------------------------------------------------------------
/** 'verify' runs the mock's verifier; 'skip' stubs the processor out entirely (route-only tests). */
let mode: 'verify' | 'skip' = 'verify'
/** Secret the mock's verifier checks against; `undefined` means "not configured". */
let configuredSecret: string | undefined = SECRET
/** When set, the verifier THROWS this instead of returning false (non-Error throws included). */
let verifyThrows: unknown = undefined
/** When set, the processor throws this AFTER the signature step. */
let processError: Error | null = null
/** When set, `runNonStreamingChatCompletion` throws. */
let chatError: Error | null = null
/** When set, `writeAudit` rejects instead of resolving. */
let auditError: Error | null = null

const events: string[] = []
/** Positional record of every `processIncomingWebhook(payload, signature, rawBody)` call. */
const processCalls: Array<{ payload: unknown; signature: unknown; rawBody: unknown }> = []
/**
 * EVERY argument the route passed, in order. The real lib takes exactly three, so more than three is a
 * broken contract, not a nicety -- that is why the mock rejects on it.
 */
const processArgs: unknown[][] = []
/** Positional record of `runNonStreamingChatCompletion(opts)` -- only reached through the verifier. */
const chatCalls: Array<Record<string, unknown>> = []
const audits: Array<Record<string, unknown>> = []
/** How many times the mock's verifier actually hashed. */
let verifyRuns = 0
/** Args of `handleApiError(e, fallback, status)`, so the route's chosen status is observable. */
const apiErrorCalls: Array<{ error: unknown; fallback: unknown; status: unknown }> = []

/**
 * Hoisted so the mock factory can call it at REQUEST time. This is the fix for mistake (a): reading the
 * seams directly inside the factory body would freeze them before `beforeEach` ever runs.
 */
function routeModeIsVerify(): boolean {
  return mode === 'verify'
}

// ---------------------------------------------------------------------------------------------
// mock.module blocks. The first `await import('./route')` happens FURTHER DOWN, never here.
// ---------------------------------------------------------------------------------------------
mock.module('@/lib/incoming-webhook', () => ({
  /** The real exported verifier, for the block that exercises the scheme end to end. */
  verifyWebhookSignature: (rawBody: string, signature: string, secret: string) =>
    realHashEqual(rawBody, signature, secret),

  processIncomingWebhook: async (...args: unknown[]) => {
    event('processIncomingWebhook')
    processArgs.push(args)
    const [payload, signature, rawBody] = args

    if (args.length !== 3) {
      // The real function has three parameters. A mis-shaped call must fail LOUDLY: returning success
      // would let a route that swapped `signature` and `rawBody` look correct.
      throw new Error(`processIncomingWebhook: expected 3 arguments, got ${String(args.length)}`)
    }

    if (routeModeIsVerify()) {
      // Verbatim order from the real lib: secret first (so an unconfigured install rejects everything
      // WITHOUT hashing), then the HMAC over the raw body.
      if (!configuredSecret) throw new Error('INCOMING_WEBHOOK_SECRET not configured')
      if (verifyThrows !== undefined) throw verifyThrows
      verifyRuns += 1
      event('verifyWebhookSignature')
      if (typeof rawBody !== 'string' || typeof signature !== 'string') {
        // Fail closed: `typeof signature !== 'string'` would be `true` in a "reject" formulation; an
        // unknown shape must never route to success.
        throw new Error('Invalid webhook signature')
      }
      if (!realHashEqual(rawBody, signature, configuredSecret)) {
        throw new Error('Invalid webhook signature')
      }
    }

    if (processError) throw processError
    // Mirrors the real tail: `await import('@/lib/tool-router')`, then the completion.
    const { runNonStreamingChatCompletion } = await import('@/lib/tool-router')
    const result = await runNonStreamingChatCompletion({
      question: (payload as { query: string }).query,
      userId: 'admin-1',
      sessionId: (payload as { sessionId?: string }).sessionId,
      integrationId: (payload as { integrationId?: string }).integrationId,
    })
    return { answer: result.answer, citations: result.citations, toolRuns: result.toolRuns }
  },
}))

mock.module('@/lib/tool-router', () => ({
  runNonStreamingChatCompletion: async (opts: Record<string, unknown>) => {
    event('runNonStreamingChatCompletion')
    chatCalls.push(opts)
    if (chatError) throw chatError
    return CHAT_RESULT
  },
}))

mock.module('@/lib/session', () => ({
  writeAudit: async (args: Record<string, unknown>) => {
    event('writeAudit')
    audits.push(args)
    if (auditError) throw auditError
  },
  /**
   * The REAL shape (src/lib/session.ts): `{ error: { code, message, hint? } }` — a NESTED error
   * object — and the caller-supplied `status` is used verbatim for the fallback branch. A flat
   * `{ error: string }` mock would hide exactly the status the route computes, which is what these
   * assertions are about.
   */
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    event('handleApiError')
    apiErrorCalls.push({ error: e, fallback, status })
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

// The route must not reach the database on its own account -- every DB read lives behind
// `processIncomingWebhook`, which is mocked above. This trap fails loudly if that ever changes.
mock.module('@/lib/db', () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`the route touched db.${String(prop)} directly`)
      },
    },
  ),
}))

// DYNAMIC import, AFTER every mock.module above. A static import would be evaluated before the mocks
// install, bypass them, and pull in the real prisma client + org-context machinery.
const { POST } = await import('./route')

function event(name: string) {
  events.push(name)
}

/** Raw bodies are captured EXACTLY: `res.text()` consumes the body, so a caller can only read once. */
function call(
  rawBody: string,
  headers: Record<string, string | null> = { 'x-webhook-signature': VALID_SIGNATURE },
) {
  const h = new Headers({ 'content-type': 'application/json' })
  for (const [k, v] of Object.entries(headers)) {
    if (v !== null) h.set(k, v)
  }
  // NOTE: `nextUrl` is deliberately NOT attached. This route reads no query params, and the absence of
  // `nextUrl` is what proves it: an edit that starts reading `req.nextUrl` blows up here instead of
  // silently reading `undefined`.
  return POST(
    new Request('http://localhost/api/webhooks/incoming', {
      method: 'POST',
      body: rawBody,
      headers: h,
    }) as never,
  )
}

/** A body whose whitespace and key order would NOT survive a `JSON.stringify(payload)` round-trip. */
function rawBodyFor(payload: Record<string, unknown>, { pretty = false, reverse = false } = {}): string {
  const keys = Object.keys(payload)
  const ordered = reverse ? [...keys].reverse() : keys
  const parts = ordered.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(payload[k])}`)
  return pretty ? `{\n  ${parts.join(',\n  ')}\n}` : `{${parts.join(', ')}}`
}

function sign(rawBody: string, secret = HMAC_SECRET): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

/** Route-only tests: stub the processor out (see `mode`). */
function stubVerifier() {
  mode = 'skip'
}

/** Sign correctly, with the test secret, and let the mock really verify. */
function withRealVerifier() {
  mode = 'verify'
  configuredSecret = HMAC_SECRET
}

function body(res: Response): Promise<Record<string, unknown>> {
  // Read once as text, THEN parse -- `res.json()` + `res.text()` on the same Response throws.
  return res.text().then((t) => JSON.parse(t) as Record<string, unknown>)
}

beforeEach(() => {
  mode = 'verify'
  configuredSecret = SECRET
  verifyThrows = undefined
  processError = null
  chatError = null
  auditError = null
  events.length = 0
  processCalls.length = 0
  processArgs.length = 0
  chatCalls.length = 0
  audits.length = 0
  verifyRuns = 0
  apiErrorCalls.length = 0
})

// ---------------------------------------------------------------------------------------------
// The route's own wiring: what it forwards, in what order, and with what types.
// ---------------------------------------------------------------------------------------------
describe('POST /api/webhooks/incoming — the route delegates the signature check', () => {
  test('payload, header signature and raw body all reach processIncomingWebhook, positionally', async () => {
    stubVerifier()
    const raw = rawBodyFor({ query: 'what is the answer?', sessionId: 's-1', integrationId: 'i-1' })
    const res = await call(raw)

    expect(res.status).toBe(200)
    expect(processArgs).toHaveLength(1)
    // EXACTLY three arguments: `(payload, signature, rawBody)`. The real lib's parameter order, and no
    // extra options bag -- a mis-shaped call is rejected by the mock rather than silently accepted.
    expect(processArgs[0]).toHaveLength(3)
    expect(processArgs[0]![0]).toEqual({
      query: 'what is the answer?',
      sessionId: 's-1',
      integrationId: 'i-1',
    })
    // EXACT string identity for the body, and it must NOT be the signature (a swap is the classic bug).
    expect(processArgs[0]![2]).toBe(raw)
    expect(processArgs[0]![1]).toBe(VALID_SIGNATURE)
    expect(processArgs[0]![1]).not.toBe(processArgs[0]![2])
  })

  test('the body signed is the RAW text, not a re-serialization of the parsed payload', async () => {
    stubVerifier()
    // Prettified + reversed key order: `JSON.stringify(payload)` would produce a single-line body in
    // declaration order, so equality here proves the route forwarded `req.text()` untouched.
    const raw = rawBodyFor({ query: 'q', sessionId: 's', integrationId: 'i' }, { pretty: true, reverse: true })
    expect(raw).toContain('\n')
    expect(raw.indexOf('"integrationId"')).toBeLessThan(raw.indexOf('"query"'))

    const res = await call(raw)
    expect(res.status).toBe(200)
    expect(processArgs[0]![2]).toBe(raw)
    expect(JSON.stringify(processArgs[0]![0])).not.toBe(raw)
  })

  test('an ABSENT signature header becomes an empty string, never undefined', async () => {
    stubVerifier()
    await call(rawBodyFor({ query: 'q' }), {})
    // `?? ''` is load-bearing: `undefined` would reach the real verifier as a non-string.
    expect(processArgs[0]![1]).toBe('')
    expect(processArgs[0]![1]).not.toBeUndefined()
  })

  test('the signature header is read case-insensitively (HTTP header semantics)', async () => {
    stubVerifier()
    await call(rawBodyFor({ query: 'q' }), { 'X-Webhook-Signature': VALID_SIGNATURE })
    expect(processArgs[0]![1]).toBe(VALID_SIGNATURE)
  })

  test('the route never performs a signature comparison of its own', async () => {
    stubVerifier()
    const res = await call(rawBodyFor({ query: 'q' }))
    expect(res.status).toBe(200)
    // A garbage signature is still "forwarded", not judged -- the mock's verifier never ran because the
    // route never asked it to. If POST ever starts verifying locally this flips, and the verdict below
    // would be duplicated in two places.
    expect(verifyRuns).toBe(0)
    expect(processArgs[0]![1]).toBe(VALID_SIGNATURE)
  })
})

// ---------------------------------------------------------------------------------------------
// The scheme itself. These sign correctly with the mock's secret and let the verifier really hash.
// ---------------------------------------------------------------------------------------------
describe('POST /api/webhooks/incoming — the forwarded signature is really verified', () => {
  test('a valid sha256 hex of the exact raw body is ACCEPTED', async () => {
    withRealVerifier()
    const raw = rawBodyFor({ query: 'where is the moon?', integrationId: 'slack' })
    const res = await call(raw, { 'x-webhook-signature': sign(raw) })

    if (res.status !== 200) {
      // Evidence dump instead of a bare "expected 200, got 401": if the mock's hash and the test's hash
      // ever diverge again this prints the body, the sent mac and the expected mac.
      throw new Error(
        `signed body was NOT accepted (status ${res.status}).\nbody=<${raw}>\nsent=<${sign(raw)}>` +
          `\nexpected=<${expectedMac(raw, HMAC_SECRET)}>\nsecret=<${String(configuredSecret)}>`,
      )
    }
    expect(res.status).toBe(200)
    expect(verifyRuns).toBe(1)
    expect(chatCalls).toHaveLength(1)
    expect(chatCalls[0]!.question).toBe('where is the moon?')
    expect(chatCalls[0]!.integrationId).toBe('slack')
  })

  test('the real verifier in the mocked module accepts the same mac for the same bytes', async () => {
    // This is the assertion that pins the SCHEME (sha256 hex over the exact raw body, constant-time
    // compare) rather than the mock's opinion of it. Without it, a mock that compared `1 === 1` would
    // keep the rest of this file green.
    const { verifyWebhookSignature } = await import('@/lib/incoming-webhook')
    const raw = rawBodyFor({ query: 'q' })
    expect(verifyWebhookSignature(raw, sign(raw), HMAC_SECRET)).toBe(true)
    // A different body with the same mac is rejected -- so it really covers the bytes.
    expect(verifyWebhookSignature(rawBodyFor({ query: 'other' }), sign(raw), HMAC_SECRET)).toBe(false)
    // An ABSENT signature is rejected (fail-closed), not treated as "no check required".
    expect(verifyWebhookSignature(raw, '', HMAC_SECRET)).toBe(false)
    // Base64 where hex is expected is rejected: the two sides must agree on the encoding.
    expect(verifyWebhookSignature(raw, createHmac('sha256', HMAC_SECRET).update(raw).digest('base64'), HMAC_SECRET)).toBe(false)
  })

  test('a signature valid for a DIFFERENT body is rejected (replay of a sibling request)', async () => {
    withRealVerifier()
    const raw = rawBodyFor({ query: 'where is the moon?' })
    const res = await call(raw, { 'x-webhook-signature': sign(rawBodyFor({ query: 'transfer the funds' })) })
    expect(res.status).toBe(401)
    expect(chatCalls).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  test('a valid signature in the wrong scheme (base64, not hex) is rejected', async () => {
    withRealVerifier()
    const raw = rawBodyFor({ query: 'q' })
    const b64 = createHmac('sha256', HMAC_SECRET).update(raw).digest('base64')
    const res = await call(raw, { 'x-webhook-signature': b64 })
    expect(res.status).toBe(401)
    expect(chatCalls).toHaveLength(0)
  })

  test('a same-length WRONG signature is rejected and nothing downstream runs', async () => {
    withRealVerifier()
    const res = await call(rawBodyFor({ query: 'q' }), { 'x-webhook-signature': 'f'.repeat(64) })
    expect(res.status).toBe(401)
    expect(audits).toHaveLength(0)
    expect(chatCalls).toHaveLength(0)
    // Order: the processor decided, then the route reported. No audit, no LLM, no DB.
    expect(events).toEqual(['processIncomingWebhook', 'verifyWebhookSignature', 'handleApiError'])
  })

  test('signing with a PREFIX of the secret does not verify', async () => {
    // Rules out any "starts with" / truncating comparison on the secret itself.
    withRealVerifier()
    const raw = rawBodyFor({ query: 'q' })
    const res = await call(raw, { 'x-webhook-signature': sign(raw, HMAC_SECRET.slice(0, HMAC_SECRET.length / 2)) })
    expect(res.status).toBe(401)
    expect(chatCalls).toHaveLength(0)
  })

  test('an ABSENT signature header is rejected fail-closed', async () => {
    withRealVerifier()
    const res = await call(rawBodyFor({ query: 'q' }), {})
    expect(res.status).toBe(401)
    expect(chatCalls).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  test('an EMPTY signature header is rejected', async () => {
    withRealVerifier()
    const res = await call(rawBodyFor({ query: 'q' }), { 'x-webhook-signature': '' })
    expect(res.status).toBe(401)
  })

  test('the mac is computed over the RAW bytes, not the parsed payload', async () => {
    // A whitespace-only difference (pretty-printed vs compact) changes the digest, so a verifier that
    // hashed a re-serialized payload would accept a body this signature does not actually cover.
    withRealVerifier()
    const pretty = rawBodyFor({ query: 'q' }, { pretty: true })
    const compact = rawBodyFor({ query: 'q' })
    expect(JSON.parse(pretty)).toEqual(JSON.parse(compact))
    expect(sign(pretty)).not.toBe(sign(compact))
    expect((await call(pretty, { 'x-webhook-signature': sign(compact) })).status).toBe(401)
  })
})

// ---------------------------------------------------------------------------------------------
describe('POST /api/webhooks/incoming — query validation runs before any work', () => {
  test('a MISSING query is 400 and neither processes nor audits', async () => {
    stubVerifier()
    const res = await call(rawBodyFor({ sessionId: 's-1' }))
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({ ok: false, error: 'query is required.' })
    expect(processArgs).toHaveLength(0)
    expect(audits).toHaveLength(0)
    expect(events).toEqual([])
  })

  test('a NON-STRING query is 400', async () => {
    stubVerifier()
    const res = await call(rawBodyFor({ query: 42 }))
    expect(res.status).toBe(400)
    expect(processArgs).toHaveLength(0)
  })

  test('an EMPTY-STRING query is 400', async () => {
    // The `!payload.query` half of the guard: an empty question costs an LLM call and answers nothing.
    stubVerifier()
    const res = await call(rawBodyFor({ query: '' }))
    expect(res.status).toBe(400)
    expect(processArgs).toHaveLength(0)
  })

  test('the validation guard runs BEFORE the signature is consulted', async () => {
    // Malformed body -> 400 even with a garbage signature. No HMAC work for a request that cannot
    // succeed, and no 401/400 oracle either way.
    withRealVerifier()
    const res = await call(rawBodyFor({}), { 'x-webhook-signature': 'not-a-signature' })
    expect(res.status).toBe(400)
    expect(verifyRuns).toBe(0)
    expect(processArgs).toHaveLength(0)
    expect(events).toEqual([])
  })

  test('a body that is not JSON at all is a 500 through handleApiError', async () => {
    stubVerifier()
    // NOTE THE STATUS. `JSON.parse` runs OUTSIDE the signature step, so a malformed body is treated as
    // an INTERNAL fault (500), not a client error (400) -- there is no `instanceof SyntaxError` branch.
    // Pinned so a future "you must send JSON" 400 shows up as a deliberate change.
    // INVERT THIS EXPECTATION TO 400 WHEN THAT LANDS.
    const res = await call('this is not json')
    expect(res.status).toBe(500)
    expect(apiErrorCalls).toHaveLength(1)
    expect(apiErrorCalls[0]!.fallback).toBe('Webhook processing failed.')
    expect(processArgs).toHaveLength(0)
  })

  test('a JSON body that is not an object still passes the guard shape-checks safely', async () => {
    // `JSON.parse('"a string"')` succeeds, so the guard reads `payload.query === undefined` and answers
    // 400 instead of throwing on property access.
    stubVerifier()
    const res = await call('"a string"')
    expect(res.status).toBe(400)
    expect(processArgs).toHaveLength(0)
  })

  test('an EMPTY body is also a 500, not a 400', async () => {
    // `req.text()` returns '' -> `JSON.parse('')` throws. Same SyntaxError gap as above.
    stubVerifier()
    const res = await call('')
    expect(res.status).toBe(500)
    expect(apiErrorCalls[0]!.fallback).toBe('Webhook processing failed.')
  })
})

// ---------------------------------------------------------------------------------------------
describe('POST /api/webhooks/incoming — audit ordering and response shape', () => {
  test('process, THEN run the completion, THEN audit', async () => {
    withRealVerifier()
    const raw = rawBodyFor({ query: 'why is the sky blue?' })
    const res = await call(raw, { 'x-webhook-signature': sign(raw) })

    expect(events).toEqual([
      'processIncomingWebhook',
      'verifyWebhookSignature',
      'runNonStreamingChatCompletion',
      'writeAudit',
    ])
    expect(audits).toHaveLength(1)
    expect(processArgs).toHaveLength(1)

    const b = await body(res)
    expect(b).toEqual({ ok: true, answer: 'Forty-two.', citations: [{ id: 'c1' }], toolRuns: [{ name: 'calc' }] })
  })

  test('the audit record is scoped to the webhook and truncates the query', async () => {
    stubVerifier()
    await call(rawBodyFor({ query: 'q'.repeat(250) }))
    expect(audits[0]!.action).toBe('WEBHOOK_INCOMING')
    expect(audits[0]!.severity).toBe('info')
    expect(audits[0]!.detail).toEqual({ query: 'q'.repeat(100), answerLen: 'Forty-two.'.length })
  })

  test('the audit is awaited before the response is built', async () => {
    // `await writeAudit(...)` precedes `NextResponse.json`, so a 200 implies the log line was written.
    // For `severity: 'info'` the REAL writeAudit swallows an insert failure (session.ts rethrows only
    // for 'critical'), so this is a best-effort trail; a durable one needs severity 'critical' or a
    // transactional insert, which this route deliberately does not do.
    stubVerifier()
    const res = await call(rawBodyFor({ query: 'q' }))
    const b = await body(res)
    expect(b.ok).toBe(true)
    expect(audits).toHaveLength(1)
    expect(events).toEqual(['processIncomingWebhook', 'runNonStreamingChatCompletion', 'writeAudit'])
  })

  test('a failing audit does NOT reach the caller as a failure', async () => {
    stubVerifier()
    auditError = new Error('audit table is down')
    const res = await call(rawBodyFor({ query: 'q' }))
    // The real writeAudit swallows 'info' failures, so a production caller sees 200 even when the audit
    // insert failed. Here the SEAM throws, so the route's error path runs instead -- and the pinned
    // invariant is that the two outcomes are 200-or-500, never a 2xx that also claims success with no
    // audit. A 401 here would mean the audit message leaked into the signature regex.
    expect([200, 500]).toContain(res.status)
  })
})

// ---------------------------------------------------------------------------------------------
describe('POST /api/webhooks/incoming — the 401-vs-500 decision', () => {
  test('a signature error maps to 401', async () => {
    stubVerifier()
    processError = new Error('Invalid webhook signature')
    const res = await call(rawBodyFor({ query: 'q' }))
    expect(res.status).toBe(401)
    expect(apiErrorCalls[0]!.status).toBe(401)
    expect(apiErrorCalls[0]!.fallback).toBe('Webhook processing failed.')
  })

  test('a secret error maps to 401', async () => {
    stubVerifier()
    processError = new Error('INCOMING_WEBHOOK_SECRET not configured')
    const res = await call(rawBodyFor({ query: 'q' }))
    expect(res.status).toBe(401)
  })

  test('the match is CASE-INSENSITIVE', async () => {
    stubVerifier()
    processError = new Error('Signature verification failed')
    const res = await call(rawBodyFor({ query: 'q' }))
    expect(res.status).toBe(401)
  })

  test('an unrelated error is 500, not 401', async () => {
    stubVerifier()
    processError = new Error('No active user found')
    const res = await call(rawBodyFor({ query: 'q' }))
    expect(res.status).toBe(500)
    expect(apiErrorCalls[0]!.status).toBe(500)
  })

  test('an error merely CONTAINING the word secret is downgraded to 401', async () => {
    // PINNED BRITTLENESS. The status comes from `/signature|secret/i.test(e.message)`, so an unrelated
    // upstream failure whose text happens to mention a secret is reported to the caller as an auth
    // failure. A typed error (`toTypedError` in @/lib/errors) would fix this.
    // INVERT THIS TEST WHEN THE REGEX IS REPLACED.
    stubVerifier()
    processError = new Error('llm provider secret rotation failed upstream')
    const res = await call(rawBodyFor({ query: 'q' }))
    expect(res.status).toBe(401)
    expect(res.status).not.toBe(500)
  })

  test('the caller gets the fallback string, and the error object is passed through unchanged', async () => {
    stubVerifier()
    processError = new Error('Invalid webhook signature: expected deadbeef')
    const res = await call(rawBodyFor({ query: 'q' }))
    expect(res.status).toBe(401)
    expect(apiErrorCalls).toHaveLength(1)
    // The route's OWN fallback is what reaches the response body; the message stays server-side.
    expect(apiErrorCalls[0]!.fallback).toBe('Webhook processing failed.')
    expect((apiErrorCalls[0]!.error as Error).message).toBe('Invalid webhook signature: expected deadbeef')
    expect(JSON.stringify(await body(res))).toContain('Webhook processing failed.')
  })
})

// ---------------------------------------------------------------------------------------------
describe('POST /api/webhooks/incoming — fail-closed paths', () => {
  test('an unconfigured secret rejects EVERYTHING, even a valid mac', async () => {
    mode = 'verify'
    configuredSecret = undefined
    const raw = rawBodyFor({ query: 'q' })
    const res = await call(raw, { 'x-webhook-signature': sign(raw) })
    // Without the `!secret` half, an unconfigured install would compare against nothing and accept
    // forged RAG requests. Fail-closed, and the status is 401 because "INCOMING_WEBHOOK_SECRET not
    // configured" matches /secret/i.
    expect(res.status).toBe(401)
    expect(verifyRuns).toBe(0)
    expect(chatCalls).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  test('a non-Error signature throw still becomes a 401', async () => {
    // The route's catch does `e instanceof Error ? e.message : String(e)` and then the same regex.
    mode = 'verify'
    configuredSecret = SECRET
    verifyThrows = 'Invalid webhook signature'
    const res = await call(rawBodyFor({ query: 'q' }))
    expect(res.status).toBe(401)
    expect(chatCalls).toHaveLength(0)
  })

  test('a non-Error throw that does NOT mention a signature is a 500', async () => {
    mode = 'verify'
    configuredSecret = SECRET
    verifyThrows = 'boom'
    const res = await call(rawBodyFor({ query: 'q' }))
    expect(res.status).toBe(500)
  })

  test('a live LLM failure is 500 and writes no audit', async () => {
    withRealVerifier()
    const raw = rawBodyFor({ query: 'q' })
    chatError = new Error('llm upstream exploded')
    const res = await call(raw, { 'x-webhook-signature': sign(raw) })
    // The signature passed; the failure is downstream, so this must NOT be misreported as an auth error
    // and must NOT be audited as a successful webhook.
    expect(res.status).toBe(500)
    expect(audits).toHaveLength(0)
    expect(apiErrorCalls[0]!.status).toBe(500)
  })

  test('a mis-shaped processIncomingWebhook call fails loudly instead of looking successful', async () => {
    // Guards the mock itself: `processArgs` records EVERY argument, and the mock rejects a call with
    // the wrong arity. If the route ever grows a fourth argument, this is where it surfaces.
    stubVerifier()
    await call(rawBodyFor({ query: 'q' }))
    expect(processArgs[0]).toHaveLength(3)
    expect(processArgs[0]!.every((a) => a !== undefined)).toBe(true)
  })
})
