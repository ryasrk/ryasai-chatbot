import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- Mocks (must be before imports of modules under test) ---

const mockGenerateSchemaDescriptions = mock(async () => ({} as Record<string, string>))
const mockIntegrationSchemaUpdate = mock(async () => ({}))
const mockFindMany = mock(async () => [] as Array<Record<string, unknown>>)

mock.module('@/lib/db', () => ({
  db: {
    integrationSchema: {
      findMany: mockFindMany,
      update: mockIntegrationSchemaUpdate,
    },
  },
}))
mock.module('@/lib/ai', () => ({ generateSchemaDescriptions: mockGenerateSchemaDescriptions }))
mock.module('@/lib/logger', () => ({ scopedLogger: () => ({ info: () => {}, warn: () => {} }) }))

// --- Imports ---

import { enrichSchemaDescriptions, safeParseColumns, safeParseSampleRow } from './schema-enrichment'

// --- Setup / teardown ---

beforeEach(() => {
  mockFindMany.mockClear()
  mockGenerateSchemaDescriptions.mockClear()
  mockIntegrationSchemaUpdate.mockClear()
})

// --- Tests ---

describe('enrichSchemaDescriptions — manualDescription', () => {
  test('skips rows with manualDescription=true', async () => {
    // One auto row + one manually-edited row. Only the auto row should be
    // passed to the LLM and updated; the manual row must be left untouched.
    mockFindMany.mockImplementation(async () => [
      { id: 'auto-1', tableName: 'users', columns: '[]', rowCount: 5, sampleRow: null, description: null, manualDescription: false },
      { id: 'manual-1', tableName: 'orders', columns: '[]', rowCount: 3, sampleRow: null, description: 'Admin-authored summary', manualDescription: true },
    ])
    mockGenerateSchemaDescriptions.mockImplementation(async () => ({ users: 'Auto summary for users.' }))

    await enrichSchemaDescriptions('int-1', 'MyDB')

    // Only the auto table is sent to the LLM.
    const call = (mockGenerateSchemaDescriptions.mock.calls[0] as unknown as [{ tables: Array<{ tableName: string }> }])[0]
    expect(call.tables.map((t) => t.tableName)).toEqual(['users'])

    // Only the auto row is updated.
    expect(mockIntegrationSchemaUpdate).toHaveBeenCalledTimes(1)
    const upd = (mockIntegrationSchemaUpdate.mock.calls[0] as unknown as [{ where: { id: string }; data: { description: string } }])[0]
    expect(upd.where.id).toBe('auto-1')
    expect(upd.data.description).toBe('Auto summary for users.')
  })

  test('no-ops when every row is manually edited', async () => {
    mockFindMany.mockImplementation(async () => [
      { id: 'm-1', tableName: 'orders', columns: '[]', rowCount: 1, sampleRow: null, description: 'manual', manualDescription: true },
    ])
    await enrichSchemaDescriptions('int-1', 'MyDB')
    expect(mockGenerateSchemaDescriptions).not.toHaveBeenCalled()
    expect(mockIntegrationSchemaUpdate).not.toHaveBeenCalled()
  })

  test('still enriches rows when manualDescription is false (default behavior preserved)', async () => {
    mockFindMany.mockImplementation(async () => [
      { id: 'a-1', tableName: 'users', columns: '[]', rowCount: 1, sampleRow: null, description: null, manualDescription: false },
    ])
    mockGenerateSchemaDescriptions.mockImplementation(async () => ({ users: 'Generated.' }))
    await enrichSchemaDescriptions('int-1', 'MyDB')
    expect(mockGenerateSchemaDescriptions).toHaveBeenCalledTimes(1)
    expect(mockIntegrationSchemaUpdate).toHaveBeenCalledTimes(1)
  })

  test('returns early when no schema rows exist', async () => {
    mockFindMany.mockImplementation(async () => [])
    await enrichSchemaDescriptions('int-1', 'MyDB')
    expect(mockGenerateSchemaDescriptions).not.toHaveBeenCalled()
    expect(mockIntegrationSchemaUpdate).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Failure and parsing edges
// ===========================================================================

describe('enrichSchemaDescriptions — when the LLM call FAILS', () => {
  function schemaRow(id: string, tableName: string, columns = '[]') {
    return {
      id, tableName, columns, rowCount: 5, sampleRow: null,
      description: null, manualDescription: false, schemaSnapshotId: 'snap-1',
    }
  }

  test('a failing description generator is CAUGHT and the run is abandoned quietly', async () => {
    // Line 40. Enrichment is a best-effort enrichment: the schema rows are already
    // stored and usable with raw column names. Letting a provider outage throw here
    // would fail the WHOLE ingestion for a cosmetic improvement.
    mockFindMany.mockImplementation(async () => [schemaRow('1', 'users')])
    mockGenerateSchemaDescriptions.mockImplementation(async () => {
      throw new Error('provider 503')
    })
    await expect(
      enrichSchemaDescriptions('i1', 'PG'),
    ).resolves.toBeUndefined()
  })

  test('a failure does NOT write any partial description', async () => {
    // The catch wraps the whole loop, so nothing is persisted -- a half-enriched
    // schema would be harder to re-run than an untouched one.
    mockFindMany.mockImplementation(async () => [schemaRow('1', 'users')])
    mockGenerateSchemaDescriptions.mockImplementation(async () => {
      throw new Error('provider 503')
    })
    await enrichSchemaDescriptions('i1', 'PG')
    expect(mockIntegrationSchemaUpdate).not.toHaveBeenCalled()
  })
})

describe('safeParseColumns — the stored JSON is untrusted', () => {
  test('malformed JSON returns [] rather than throwing', async () => {
    // Line 54. `columns` is a TEXT column written by an earlier version of the
    // ingestion path, so a truncated or hand-edited value must not break reading
    // an existing integration.
    expect(safeParseColumns('{not json')).toEqual([])
  })

  test('valid JSON that is NOT an array returns []', async () => {
    // An object is valid JSON but not a column list.
    expect(safeParseColumns('{"name":"id"}')).toEqual([])
    expect(safeParseColumns('"a string"')).toEqual([])
    expect(safeParseColumns('null')).toEqual([])
  })

  test('columns are COERCED to the declared shape', async () => {
    // Lines 49-52. Each entry is rebuilt field by field, so a stored row with extra
    // or missing keys cannot leak arbitrary data into the prompt.
    const parsed = safeParseColumns(
      JSON.stringify([
        { name: 'id', type: 'int', primaryKey: true, extra: 'dropped' },
        { name: 5, type: null },
        {},
      ]),
    )
    expect(parsed).toEqual([
      { name: 'id', type: 'int', primaryKey: true },
      { name: '5', type: '' },
      { name: '', type: '' },
    ])
  })

  test('primaryKey is true or UNDEFINED, never false', async () => {
    // `Boolean(...) || undefined` -- a false primaryKey would be indistinguishable
    // from a missing one at the call site, so it is normalised away.
    //
    // MEASURED: the KEY IS STILL PRESENT with the value undefined (`'primaryKey' in
    // parsed[0]` is TRUE). My first version asserted the key was absent and failed;
    // `{ ...primaryKey: undefined }` is not the same as `{}` in JS. The code is
    // consistent either way for a consumer, so the measured shape is what is pinned.
    const parsed = safeParseColumns(JSON.stringify([{ name: 'a', type: 't', primaryKey: false }]))
    expect(parsed[0]).toEqual({ name: 'a', type: 't' })
    expect(parsed[0].primaryKey).toBeUndefined()
    expect(parsed[0].primaryKey).not.toBe(false)
  })
})

describe('safeParseSampleRow — untrusted JSON, object only', () => {
  test('a falsy raw value is null WITHOUT attempting a parse', async () => {
    // The `if (!raw) return null` guard: null, undefined and '' must not reach
    // JSON.parse.
    expect(safeParseSampleRow(null)).toBeNull()
    expect(safeParseSampleRow(undefined)).toBeNull()
    expect(safeParseSampleRow('')).toBeNull()
  })

  test('malformed JSON is null', async () => {
    // Line 65.
    expect(safeParseSampleRow('{not json')).toBeNull()
  })

  test('an ARRAY or a primitive is rejected, an object is kept', async () => {
    // Lines 62-63. A sample row must be a single record; an array would render as
    // a positional table rather than column names.
    expect(safeParseSampleRow('[1,2,3]')).toBeNull()
    expect(safeParseSampleRow('42')).toBeNull()
    expect(safeParseSampleRow('"text"')).toBeNull()
    expect(safeParseSampleRow('null')).toBeNull()
    expect(safeParseSampleRow('{"id":1,"name":"a"}')).toEqual({ id: 1, name: 'a' })
  })
})
