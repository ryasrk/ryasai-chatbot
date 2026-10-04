import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
let role = 'admin'
let blocked = false
const realFetch = global.fetch
const audit = mock(async () => {})
mock.module('@/lib/session', () => ({
  getActiveUser: async () => ({ userId: 'admin', organizationId: 'org', role }),
  requireRole: (user: { role: string }) => { if (user.role !== 'admin') throw Object.assign(new Error('Requires admin'), { status: 403 }) },
  writeAudit: audit,
  handleApiError: (e: unknown) => Response.json({ ok: false, error: 'Request failed' }, { status: (e as {status?: number}).status ?? 500 }),
}))
mock.module('@/lib/prisma-tenant', () => ({ enterWithOrg: () => {} }))
mock.module('@/lib/llm-config', () => ({ isBlockedHost: () => blocked, isBlockedHostAsync: async () => blocked }))
import { POST } from './route'
const req = (payload: unknown) => new NextRequest('http://localhost/api/integration-api/test', { method: 'POST', body: JSON.stringify(payload) })
beforeEach(() => { role = 'admin'; blocked = false; audit.mockClear(); global.fetch = mock(async () => new Response('success')) as unknown as typeof fetch })
afterEach(() => { global.fetch = realFetch })
describe('integration explorer proxy', () => {
  test('returns upstream status and body, and uses manual redirects', async () => {
    const fetchSpy = mock(async (_url: string, init: RequestInit) => { expect(init.redirect).toBe('manual'); return new Response('answer', { status: 201 }) })
    global.fetch = fetchSpy as unknown as typeof fetch
    const res = await POST(req({ url: 'https://example.com/test', params: { x: '1' }, headers: { Host: 'bad', 'X-Custom': 'yes' } }))
    expect(await res.json()).toMatchObject({ ok: true, status: 201, body: 'answer', truncated: false })
    expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/test?x=1')
    expect(fetchSpy.mock.calls[0][1].headers).toEqual({ 'X-Custom': 'yes' })
    expect(audit).toHaveBeenCalledTimes(1)
  })
  test('viewers and private hosts cannot send an upstream request', async () => {
    const fetchSpy = global.fetch as unknown as ReturnType<typeof mock>
    role = 'viewer'
    expect((await POST(req({ url: 'https://example.com' }))).status).toBe(403)
    role = 'admin'; blocked = true
    expect((await POST(req({ url: 'https://example.com' }))).status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  test('invalid JSON and incorrectly typed values are client errors', async () => {
    for (const payload of [{ method: 7, url: 'https://example.com' }, { url: 123 }, { url: 'file:///tmp/a' }, { url: 'bad' }]) {
      expect((await POST(req(payload))).status).toBe(400)
    }
    expect((await POST(new NextRequest('http://localhost/api/integration-api/test', { method: 'POST', body: '{' }))).status).toBe(400)
  })
  test('over-limit request bodies are refused before the outbound fetch', async () => {
    expect((await POST(req({ url: 'https://example.com', body: 'x'.repeat(1_000_000) }))).status).toBe(413)
    expect(global.fetch).not.toHaveBeenCalled()
  })
  test('large upstream bodies stop transferring and report a partial result', async () => {
    let cancelled = false
    global.fetch = mock(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(250_000))) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }))) as unknown as typeof fetch
    const body = await (await POST(req({ url: 'https://example.com' }))).json()
    expect(body).toMatchObject({ ok: false, truncated: true })
    expect(body.body.length).toBe(200_000)
    expect(body.error).toContain('partial')
    expect(cancelled).toBe(true)
  })
  test('an upstream body read failure cannot claim success', async () => {
    global.fetch = mock(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('lost connection')) } }))) as unknown as typeof fetch
    const res = await POST(req({ url: 'https://example.com' }))
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ ok: false, error: 'Failed to read the upstream response.' })
  })
})
