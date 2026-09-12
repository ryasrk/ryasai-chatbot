import { describe, expect, test, mock, beforeEach } from 'bun:test'

// INCIDENT (2026-09): three divergent integration pickers. The non-streaming
// branch used `orderBy: { createdAt: 'asc' }` — the OLDEST active source, chosen
// without looking at the question. Proven at runtime: with an HR database
// created before a Sales database, "berapa total penjualan?" ran against HR.
// It failed SILENTLY — shared table names produced valid SQL and a confidently
// wrong answer, with no error and no log.
//
// These tests pin the two properties that fix it:
//   1. a question that matches a source selects THAT source (not the oldest);
//   2. a question that matches NOTHING makes us REFUSE and name the candidates
//      rather than silently returning the oldest.

const mockIntegrationFindMany = mock(async (): Promise<unknown> => [])

mock.module('@/lib/db', () => ({
  db: {
    integration: { findMany: mockIntegrationFindMany, findFirst: mock(async () => null), count: mock(async () => 0) },
    llmConfig: { findFirst: mock(async () => null) },
  },
}))

const { resolveIntegrationForQuestion } = await import('@/lib/smart-router')

const HR = {
  id: 'hr-1',
  name: 'HR Database',
  status: 'active',
  createdAt: new Date('2024-01-01'), // OLDEST — the old code always picked this
  schemas: [{ tableName: 'employees', columns: JSON.stringify([{ name: 'salary' }, { name: 'hire_date' }]), description: null }],
}
const SALES = {
  id: 'sales-1',
  name: 'Sales Database',
  status: 'active',
  createdAt: new Date('2025-06-01'),
  schemas: [{ tableName: 'orders', columns: JSON.stringify([{ name: 'total_amount' }, { name: 'customer_id' }]), description: null }],
}

beforeEach(() => {
  mockIntegrationFindMany.mockReset()
  mockIntegrationFindMany.mockImplementation(async () => [HR, SALES])
})

describe('resolveIntegrationForQuestion', () => {
  test('picks the source the question matches, NOT the oldest', async () => {
    const choice = await resolveIntegrationForQuestion(['orders', 'amount'], 'berapa total penjualan orders?', 'refuse')
    expect(choice).not.toBeNull()
    expect(choice!.integrationId).toBe('sales-1')
    expect(choice!.integrationId).not.toBe('hr-1') // the old behaviour
  })

  test('refuses when nothing matches, instead of silently taking the oldest', async () => {
    const choice = await resolveIntegrationForQuestion(['xyzzy'], 'apa itu xyzzy?', 'refuse')
    expect(choice).toBeNull() // <-- the whole point
  })

  test("'oldest' keeps the legacy behaviour for unattended runs, and MARKS it", async () => {
    const choice = await resolveIntegrationForQuestion(['xyzzy'], 'apa itu xyzzy?', 'oldest')
    expect(choice).not.toBeNull()
    expect(choice!.integrationId).toBe('hr-1') // oldest, as before
    expect(choice!.unverified).toBe(true) // but now flagged, never silently
  })

  test('a matched pick is never marked unverified', async () => {
    const choice = await resolveIntegrationForQuestion(['orders'], 'orders?', 'refuse')
    expect(choice!.unverified).toBe(false)
  })

  test('single source is unambiguous and does not require a match', async () => {
    mockIntegrationFindMany.mockImplementation(async () => [SALES])
    const choice = await resolveIntegrationForQuestion(['xyzzy'], 'anything', 'refuse')
    expect(choice?.integrationId).toBe('sales-1')
  })

  test('no sources at all returns null rather than inventing one', async () => {
    mockIntegrationFindMany.mockImplementation(async () => [])
    expect(await resolveIntegrationForQuestion(['orders'], 'orders?', 'refuse')).toBeNull()
  })
})
