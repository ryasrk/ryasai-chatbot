import { describe, expect, test, mock, beforeEach } from 'bun:test'

let userRow: { role: string } | null = { role: 'viewer' }
let policyRows: Array<{ tableName: string; allowedColumns: string | null }> = []
let hiddenCount = 0
let visibleDocs: Array<{ id: string }> = []
let lastFindManyWhere: unknown = null

mock.module('@/lib/db', () => ({
  db: {
    user: { findFirst: async () => userRow },
    dataAccessPolicy: { findMany: async () => policyRows },
    document: {
      count: async () => hiddenCount,
      findMany: async (q: { where: unknown }) => {
        lastFindManyWhere = q.where
        return visibleDocs
      },
    },
  },
}))

const {
  normalizeRole,
  resolveUserRole,
  loadSqlAccessPolicy,
  filterSchemaForPolicy,
  narrowDocumentScope,
  documentVisibilityWhere,
  NO_DOCUMENTS_SENTINEL,
} = await import('@/lib/access-scope')

beforeEach(() => {
  userRow = { role: 'viewer' }
  policyRows = []
  hiddenCount = 0
  visibleDocs = []
  lastFindManyWhere = null
})

describe('roles', () => {
  test('an unknown or missing role is the most restricted one', async () => {
    expect(normalizeRole('superuser')).toBe('viewer')
    expect(normalizeRole(undefined)).toBe('viewer')
    userRow = null
    expect(await resolveUserRole('ghost')).toBe('viewer')
    expect(await resolveUserRole(null)).toBe('viewer')
  })

  test('admin and analyst are read from the user row', async () => {
    userRow = { role: 'analyst' }
    expect(await resolveUserRole('u1')).toBe('analyst')
  })
})

describe('loadSqlAccessPolicy', () => {
  test('open mode and admin are unrestricted (null)', async () => {
    policyRows = [{ tableName: 'orders', allowedColumns: null }]
    expect(await loadSqlAccessPolicy({ id: 'i', accessMode: 'open' }, 'viewer')).toBeNull()
    expect(await loadSqlAccessPolicy({ id: 'i', accessMode: 'restricted' }, 'admin')).toBeNull()
  })

  test('restricted mode lowercases table and column names', async () => {
    policyRows = [
      { tableName: 'Orders', allowedColumns: '["Total","created_at"]' },
      { tableName: 'customers', allowedColumns: null },
    ]
    const p = await loadSqlAccessPolicy({ id: 'i', accessMode: 'restricted' }, 'viewer')
    expect([...p!.tables.keys()]).toEqual(['orders', 'customers'])
    expect([...p!.tables.get('orders')!.allowedColumns!]).toEqual(['total', 'created_at'])
    expect(p!.tables.get('customers')!.allowedColumns).toBeNull()
  })

  test('a MALFORMED column list grants no column rather than every column', async () => {
    policyRows = [{ tableName: 'orders', allowedColumns: '{not json' }]
    const p = await loadSqlAccessPolicy({ id: 'i', accessMode: 'restricted' }, 'viewer')
    expect(p!.tables.get('orders')!.allowedColumns!.size).toBe(0)
  })

  test('restricted with no rows denies every table', async () => {
    const p = await loadSqlAccessPolicy({ id: 'i', accessMode: 'restricted' }, 'analyst')
    expect(p!.tables.size).toBe(0)
  })
})

describe('filterSchemaForPolicy', () => {
  const tables = [
    { tableName: 'employees', columns: [{ name: 'id' }, { name: 'name' }, { name: 'salary' }], sampleRow: { id: 1, name: 'Budi', salary: 25000000 } },
    { tableName: 'payroll', columns: [{ name: 'amount' }] },
  ]

  test('null policy returns the schema unchanged', () => {
    expect(filterSchemaForPolicy(tables, null)).toBe(tables)
  })

  test('ungranted tables and columns are removed, and the SAMPLE ROW is stripped of restricted values', () => {
    const out = filterSchemaForPolicy(tables, {
      tables: new Map([['employees', { allowedColumns: new Set(['id', 'name']) }]]),
    })
    expect(out).toHaveLength(1)
    expect(out[0].columns.map((c) => c.name)).toEqual(['id', 'name'])
    expect(out[0].sampleRow as Record<string, unknown>).toEqual({ id: 1, name: 'Budi' })
  })
})

describe('narrowDocumentScope', () => {
  test('admin keeps the requested scope untouched', async () => {
    expect(await narrowDocumentScope('admin', ['d1'])).toEqual(['d1'])
    expect(await narrowDocumentScope('admin', null)).toBeNull()
  })

  test('no hidden document means no narrowing (and no id list query)', async () => {
    hiddenCount = 0
    expect(await narrowDocumentScope('viewer', null)).toBeNull()
    expect(lastFindManyWhere).toBeNull()
  })

  test('hidden documents narrow the scope to the visible ids, intersected with the request', async () => {
    hiddenCount = 2
    visibleDocs = [{ id: 'd1' }]
    expect(await narrowDocumentScope('viewer', ['d1', 'd9'])).toEqual(['d1'])
    expect(lastFindManyWhere).toEqual({ allowedRoles: { has: 'viewer' }, id: { in: ['d1', 'd9'] } })
  })

  test('nothing visible yields a sentinel, NEVER [] — an empty list means "unrestricted" to every consumer', async () => {
    hiddenCount = 3
    visibleDocs = []
    expect(await narrowDocumentScope('viewer', null)).toEqual([NO_DOCUMENTS_SENTINEL])
  })

  test('the listing filter is empty for admin and role-scoped otherwise', () => {
    expect(documentVisibilityWhere('admin')).toEqual({})
    expect(documentVisibilityWhere('analyst')).toEqual({ allowedRoles: { has: 'analyst' } })
  })
})
