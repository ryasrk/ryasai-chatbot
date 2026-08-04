import { afterEach, describe, expect, it } from 'bun:test'
import { fetchUrlForPlanner, webSearch, getSearxngEndpoint } from '@/lib/web-fetch'

describe('web-fetch', () => {
  it('rejects invalid URL', async () => {
    const r = await fetchUrlForPlanner('not-a-url')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('rejects non-http protocols', async () => {
    const r = await fetchUrlForPlanner('ftp://example.com/file')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('http')
  })

  it('rejects blocked internal host (localhost)', async () => {
    const r = await fetchUrlForPlanner('http://localhost:8080')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('blocked')
  })

  it('rejects blocked internal host (169.254.x metadata)', async () => {
    const r = await fetchUrlForPlanner('http://169.254.169.254/latest')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('blocked')
  })

  it('rejects empty URL', async () => {
    const r = await fetchUrlForPlanner('')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

describe('webSearch', () => {
  it('rejects empty query', async () => {
    const r = await webSearch('')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('rejects whitespace-only query', async () => {
    const r = await webSearch('   ')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

describe('getSearxngEndpoint', () => {
  const original = process.env.SEARXNG_URL
  afterEach(() => {
    if (original === undefined) delete process.env.SEARXNG_URL
    else process.env.SEARXNG_URL = original
  })

  it('unset or blank → null (DuckDuckGo fallback stays the default)', () => {
    delete process.env.SEARXNG_URL
    expect(getSearxngEndpoint()).toBeNull()
    process.env.SEARXNG_URL = '   '
    expect(getSearxngEndpoint()).toBeNull()
  })

  it('strips trailing slashes so /search is not doubled up', () => {
    process.env.SEARXNG_URL = 'http://searxng:8080//'
    expect(getSearxngEndpoint()).toBe('http://searxng:8080')
  })

  it('preserves a subpath deployment', () => {
    process.env.SEARXNG_URL = 'https://example.com/searx/'
    expect(getSearxngEndpoint()).toBe('https://example.com/searx')
  })

  it('rejects non-http protocols and garbage', () => {
    process.env.SEARXNG_URL = 'file:///etc/passwd'
    expect(getSearxngEndpoint()).toBeNull()
    process.env.SEARXNG_URL = 'not-a-url'
    expect(getSearxngEndpoint()).toBeNull()
  })
})
