import { describe, expect, it } from 'bun:test'
import { fetchUrlForPlanner } from '@/lib/web-fetch'

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
