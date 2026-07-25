import { describe, expect, test } from 'bun:test'
import { middleware, config } from '../middleware'
import type { NextRequest } from 'next/server'

function mockReq(pathname: string, cookie?: string): NextRequest {
  return {
    nextUrl: { pathname },
    cookies: {
      get: (name: string) => (name === 'x-active-user' ? { value: cookie } : undefined),
    },
  } as unknown as NextRequest
}

describe('middleware config matcher', () => {
  test('excludes _next/static, _next/image, favicon.ico; includes other paths', () => {
    // ponytail: anchor to simulate Next.js full-path matcher semantics;
    // without ^...$ the unanchored regex would match at a later '/' in the path.
    const re = new RegExp('^' + config.matcher[0] + '$')
    expect(re.test('/_next/static/chunk.js')).toBe(false)
    expect(re.test('/_next/image/logo.png')).toBe(false)
    expect(re.test('/favicon.ico')).toBe(false)
    expect(re.test('/api/keys')).toBe(true)
    expect(re.test('/')).toBe(true)
  })
})

describe('middleware function', () => {
  test('no cookie on protected api path → 401', async () => {
    const res = middleware(mockReq('/api/keys'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  test('with cookie on protected api path → passes through', () => {
    const res = middleware(mockReq('/api/keys', 'userId.sig'))
    expect(res.status).toBe(200)
  })

  test('public api path → passes through without cookie', () => {
    const res = middleware(mockReq('/api/auth/login'))
    expect(res.status).toBe(200)
  })

  test('non-api path → passes through', () => {
    const res = middleware(mockReq('/dashboard'))
    expect(res.status).toBe(200)
  })
})
