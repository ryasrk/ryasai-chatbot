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

  test('builds auth headers', () => {
    expect(buildAuthHeaders('BEARER', { token: 'abc' })).toEqual({
      Authorization: 'Bearer abc',
    })
    expect(
      buildAuthHeaders('API_KEY_HEADER', {
        headerName: 'X-API-Key',
        apiKey: 'secret',
      }),
    ).toEqual({ 'X-API-Key': 'secret' })
    expect(buildAuthHeaders('NONE', {})).toEqual({})
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
