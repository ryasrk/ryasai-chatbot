import { describe, expect, test } from 'bun:test'
import { parseAuditPagination } from './route'

describe('audit pagination', () => {
  test('caps page size at 20 events per page', () => {
    const pagination = parseAuditPagination(new URLSearchParams('page=1&pageSize=50'))

    expect(pagination).toEqual({ page: 1, pageSize: 20 })
  })
})
