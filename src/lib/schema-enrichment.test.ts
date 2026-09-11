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

import { enrichSchemaDescriptions } from './schema-enrichment'

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
