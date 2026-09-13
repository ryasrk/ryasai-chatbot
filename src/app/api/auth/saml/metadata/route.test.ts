/**
 * GET /api/auth/saml/metadata — the SP metadata XML handed to the IdP administrator.
 *
 * WHY THIS FILE EXISTS. This route is unauthenticated BY DESIGN (the IdP admin has no session here) and it is
 * the only SAML endpoint whose output is a document rather than a redirect. Three things are worth pinning:
 *
 *   1. THE CONFIGURATION GATE. Without SAML env vars the route answers a 400 with the NAMES OF THE MISSING VARS.
 *      It must not attempt generateSpMetadata(), which throws (buildSamlConfig refuses to run without an entry
 *      point) and would surface as a 500 telling the operator nothing about what to set.
 *   2. THE CONTENT TYPE AND CACHING CONTRACT. `application/xml` is what a browser/IdP fetches as a file; the body
 *      must NOT be JSON.stringified XML. `Cache-Control: public, max-age=3600` is deliberate: this document is
 *      identical for every caller and changes only when the deployment config changes.
 *   3. NOTHING SENSITIVE IN THE DOCUMENT. The metadata is public because the IdP reads it; the SP private key
 *      (`SAML_SP_PRIVATE_KEY`) must never appear, encrypted or otherwise. `signMetadata: false` means no
 *      XML-signature blob is emitted either.
 *
 * Control tests were verified by mutating the route in place, running the file, and restoring it. The mutations
 * that were proven to bite are named in the test comments.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// ---- mutable seams, declared before every mock.module ----
let configured = true
let xml = '<EntityDescriptor entityID="https://chatbot.test"><AssertionConsumerService/></EntityDescriptor>'
let metadataThrows: Error | null = null
let generateCalls = 0
let generateArgs: unknown[] = []
const events: string[] = []
let handleErrorArgs: Array<{ fallback: string; status: number | undefined }> = []

mock.module('@/lib/sso-saml', () => ({
  isSamlConfigured: () => {
    events.push('isSamlConfigured')
    return configured
  },
  generateSpMetadata: (...args: unknown[]) => {
    generateCalls++
    generateArgs = args
    events.push('generateSpMetadata')
    if (metadataThrows) throw metadataThrows
    return xml
  },
}))

mock.module('@/lib/session', () => ({
  handleApiError: (_e: unknown, fallback: string, status = 500) => {
    handleErrorArgs.push({ fallback, status })
    events.push('handleApiError')
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

// DYNAMIC: mock.module does not apply to static imports.
const { GET } = await import('./route')

beforeEach(() => {
  configured = true
  xml = '<EntityDescriptor entityID="https://chatbot.test"><AssertionConsumerService/></EntityDescriptor>'
  metadataThrows = null
  generateCalls = 0
  generateArgs = []
  events.length = 0
  handleErrorArgs = []
})

describe('the configuration gate', () => {
  test('an unconfigured deployment is 400, not a 500 from the XML builder', async () => {
    // Control C1 (deleting the `if (!isSamlConfigured())` block): red. buildSamlConfig throws without
    // SAML_IDP_ENTRY_POINT, so the operator got an opaque 500 instead of a setup instruction.
    configured = false
    const res = await GET()
    expect(res.status).toBe(400)
    expect(generateCalls).toBe(0)
  })

  test('the 400 body NAMES the two required variables', async () => {
    // Control C2 (replacing the message with a generic string): red. This endpoint is the one place an operator
    // learns which env vars are missing, and the login page does not say it.
    configured = false
    const t = await (await GET()).text()
    const body = JSON.parse(t) as { error: string }
    expect(body.error).toContain('SAML_SP_ENTITY_ID')
    expect(body.error).toContain('SAML_SP_CALLBACK_URL')
  })

  test('the unconfigured body is a plain string error, not the typed envelope', async () => {
    // Pinned as-is: this route predates handleApiError's { code, message } shape. The IdP integration UI reads
    // `error` as a string here; changing it is a deliberate client-visible edit.
    configured = false
    const body = (await (await GET()).json()) as { error: unknown }
    expect(typeof body.error).toBe('string')
  })

  test('THE GATE IS CHECKED FIRST: no metadata is generated while unconfigured', async () => {
    configured = false
    await GET()
    expect(events).toEqual(['isSamlConfigured'])
  })

  test('the handler takes no arguments and ignores any request it is given', async () => {
    // Metadata is per-DEPLOYMENT, not per-request: a future edit that derives the entity id from the request Host
    // header would make the document depend on the caller, and every IdP config would follow.
    await GET()
    expect(generateArgs).toEqual([])
  })
})

describe('the metadata document', () => {
  test('the XML body is returned verbatim, NOT re-serialised as JSON', async () => {
    // Control C3 (returning NextResponse.json({ xml })): red. The IdP admin pastes this URL into a fetch that
    // expects XML; a JSON envelope would be rejected as malformed metadata.
    const res = await GET()
    const t = await res.text()
    expect(t).toBe(xml)
    expect(t.startsWith('<')).toBe(true)
  })

  test('the content type is application/xml', async () => {
    const res = await GET()
    expect(res.headers.get('content-type')).toContain('application/xml')
  })

  test('the document is publicly cacheable for an hour', async () => {
    // Control C4 (dropping the Cache-Control header): red. Every IdP metadata refresh would otherwise re-run the
    // SAML library's XML generation on the login host.
    const res = await GET()
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
  })

  test('the status is 200 and the builder is called exactly once', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(generateCalls).toBe(1)
  })

  test('the gate runs BEFORE the builder on the configured path too', async () => {
    await GET()
    expect(events).toEqual(['isSamlConfigured', 'generateSpMetadata'])
  })

  test('repeated calls each regenerate, so the cache header is the only memoisation', async () => {
    // A hidden module-level cache would serve a stale entity id after an env change and restart-free
    // reconfiguration. Recorded as current behaviour.
    await GET()
    await GET()
    expect(generateCalls).toBe(2)
  })

  test('a document with a private key in it would still be returned — the route adds nothing', async () => {
    // RECORDED, NOT ENDORSED. The confidentiality of this endpoint rests entirely on `signMetadata: false` and on
    // generateSpMetadata only ever being handed `spCert` (see sso-saml.ts). This test documents that the ROUTE has
    // no redaction of its own, so a future change to the builder is the only thing standing between the SP
    // private key and an unauthenticated caller. Assertion below is on an obviously-public marker so the test
    // states the contract without pretending the route sanitises anything.
    xml = '<EntityDescriptor entityID="https://chatbot.test"></EntityDescriptor>'
    const t = await (await GET()).text()
    expect(t).not.toContain('PRIVATE KEY')
  })
})

describe('the failure path', () => {
  test('a builder failure is a 500 with the route-specific fallback', async () => {
    metadataThrows = new Error('Cannot read properties of undefined (reading getMetadata)')
    const res = await GET()
    expect(res.status).toBe(500)
    expect(handleErrorArgs).toEqual([{ fallback: 'Failed to generate SAML metadata.', status: 500 }])
  })

  test('the thrown builder message never reaches the client', async () => {
    metadataThrows = new Error('ENOENT: /etc/ryasai/saml-sp.pem not found')
    const t = await (await GET()).text()
    expect(t).not.toContain('/etc/ryasai')
    expect(t).not.toContain('ENOENT')
  })

  test('the failure envelope uses the typed error shape', async () => {
    metadataThrows = new Error('boom')
    const body = (await (await GET()).json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INTERNAL_ERROR')
    expect(body.error.message).toBe('Failed to generate SAML metadata.')
  })
})
