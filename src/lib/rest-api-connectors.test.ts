import { describe, expect, test } from 'bun:test'
import {
  buildAuthHeaders,
  buildEndpointUrl,
  matchEndpoint,
  sanitizeHeaders,
  type EndpointDefinition,
} from './rest-api-connectors'

const endpoints: EndpointDefinition[] = [
  { id: 'ep_1', method: 'GET', path: '/invoices', enabled: true },
  { id: 'ep_2', method: 'POST', path: '/tickets', enabled: false },
]

describe('REST API connector utilities', () => {
  test('matches only enabled endpoint by method and path', () => {
    expect(matchEndpoint('get', '/invoices', endpoints)?.id).toBe('ep_1')
    expect(matchEndpoint('POST', '/tickets', endpoints)).toBeNull()
    expect(matchEndpoint('GET', '/customers', endpoints)).toBeNull()
  })

  test('builds URL with query params', () => {
    expect(
      buildEndpointUrl('https://api.example.com/base', '/invoices', {
        status: 'overdue',
        page: 2,
      }),
    ).toBe('https://api.example.com/base/invoices?status=overdue&page=2')
  })

  test('builds auth headers', async () => {
    expect(await buildAuthHeaders('BEARER', { token: 'abc' })).toEqual({
      Authorization: 'Bearer abc',
    })
    expect(
      await buildAuthHeaders('API_KEY_HEADER', {
        headerName: 'X-API-Key',
        apiKey: 'secret',
      }),
    ).toEqual({ 'X-API-Key': 'secret' })
    expect(await buildAuthHeaders('NONE', {})).toEqual({})
  })

  test('builds BASIC auth header', async () => {
    const headers = await buildAuthHeaders('BASIC', {
      username: 'admin',
      password: 'secret123',
    })
    expect(headers.Authorization).toMatch(/^Basic /)
    const decoded = Buffer.from(
      headers.Authorization.replace('Basic ', ''),
      'base64',
    ).toString()
    expect(decoded).toBe('admin:secret123')
  })

  test('BASIC auth with empty creds returns no header', async () => {
    expect(await buildAuthHeaders('BASIC', {})).toEqual({})
  })

  test('OAUTH2 with missing config returns no header', async () => {
    expect(await buildAuthHeaders('OAUTH2', {})).toEqual({})
    expect(await buildAuthHeaders('OAUTH2', { tokenUrl: 'https://x.com/token' })).toEqual({})
  })

  test('sanitizes sensitive headers', () => {
    expect(
      sanitizeHeaders({ Authorization: 'Bearer abc', 'X-Trace': '1' }),
    ).toEqual({
      Authorization: '••••',
      'X-Trace': '1',
    })
  })
})
