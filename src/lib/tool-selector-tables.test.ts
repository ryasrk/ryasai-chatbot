/**
 * Which tables represent each database in the selector prompt, when MANY databases are connected.
 *
 * MEASURED with a recorder model standing in for the provider (six databases, 3–40 tables each): the selector showed
 * each database as the first 8 of an UNORDERED first 25 tables, so the table that answered the question
 * (`HR.leave_balances`, one of 40) was among the hidden "+N more" — the model could only guess the database from its
 * name. The 8 shown are now the most relevant to the question. Drives the REAL `selectToolWithLlm`.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

let lastMessages: Array<{ role: string; content: string }> = []
let findManyArgs: Record<string, unknown> | null = null
let expansions: string[] = []

mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: async () => ({ id: 'r1', provider: 'openai', baseUrl: 'http://x', model: 'm', apiKey: 'k' }),
  getRoleLlmConfig: async () => null,
}))
mock.module('@/lib/llm-client', () => ({
  chatOnce: async (_cfg: unknown, messages: Array<{ role: string; content: string }>) => {
    lastMessages = messages
    return 'no tool needed'
  },
}))
mock.module('@/lib/unified-tools', () => ({
  SQL_TOOL: { id: 'sql', name: 'query_database', description: 'db', category: 'database', parameters: {} },
  getUnifiedTools: async () => [
    { id: 'sql', name: 'query_database', description: 'Query structured relational data', category: 'database', requiresDataSource: 'integration', parameters: { type: 'object', properties: {}, required: [] } },
  ],
  toLlmToolDef: (t: { name: string; description: string }) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', properties: {}, required: [] } } }),
  functionNameToToolId: () => 'sql',
}))
// The translation bridge is intent-pipeline's; stubbed so the test controls the "translated" phrasings exactly.
mock.module('@/lib/intent-pipeline', () => ({ expandQuery: () => expansions }))

const filler = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}_${String(i).padStart(2, '0')}`)
const shuffled = (xs: string[]) => [...xs].sort(() => Math.random() - 0.5)
const DATABASES = [
  { id: 'hr', name: 'HR', tables: [...filler('hr_aux', 30), 'employees', 'departments', 'payroll_runs', 'leave_balances', ...filler('hr_more', 6)] },
  { id: 'log', name: 'Logistics', tables: [...filler('log_aux', 20), 'shipments', 'carriers', 'delivery_events'] },
  { id: 'sup', name: 'Support', tables: ['tickets', 'agents', 'sla_policies'] },
]
mock.module('@/lib/db', () => ({
  db: {
    integration: {
      findMany: async (args: Record<string, unknown>) => {
        findManyArgs = args
        // Storage order, as Postgres returns rows with no ORDER BY: shuffled. The code must not depend on it.
        return DATABASES.map((d) => ({ id: d.id, name: d.name, schemas: shuffled(d.tables).map((tableName) => ({ tableName })) }))
      },
    },
  },
}))
mock.module('@/lib/memory-routing', () => ({ routingMemoryBlock: () => '' }))
mock.module('@/lib/logger', () => ({ logSwallowed: () => () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } }))

const { selectToolWithLlm } = await import('@/lib/tool-selector')

const lineFor = (name: string) =>
  lastMessages.map((m) => m.content).join('\n').split('\n').find((l) => l.startsWith(`- ${name} — `)) ?? ''
const ask = (question: string) => selectToolWithLlm({ question, context: 'chat', isAdmin: false, needsDatabaseListing: true })

beforeEach(() => {
  lastMessages = []
  findManyArgs = null
  expansions = []
})

describe('the tables shown for each database are the ones the question needs', () => {
  test('a leave question shows HR.leave_balances, though it is one of 40 tables', async () => {
    await ask('How many leave days does employee 7 have left?')
    expect(lineFor('HR')).toContain('leave_balances')
    expect(lineFor('HR')).toContain('employees')
    // The count of what is NOT shown stays honest.
    expect(lineFor('HR')).toContain('+32 more')
  })

  test('a shipment question shows Logistics.shipments', async () => {
    await ask('Which shipments are late this week?')
    expect(lineFor('Logistics')).toMatch(/— shipments,/)
  })

  test('an Indonesian question reaches an English table through the translated phrasings', async () => {
    expansions = ['berapa sisa leave employee 7?']
    await ask('Berapa sisa cuti karyawan 7?')
    expect(lineFor('HR')).toContain('leave_balances')
  })

  test('with nothing relevant the order is still DEFINED (alphabetical), not storage order', async () => {
    await ask('halo apa kabar')
    const first = lineFor('Support')
    await ask('halo apa kabar')
    expect(lineFor('Support')).toBe(first)
  })

  test('the query loads every table in a defined order, not an unordered first 25', async () => {
    await ask('anything')
    const schemas = (findManyArgs?.select as { schemas: { orderBy?: unknown; take?: number } }).schemas
    expect(schemas.orderBy).toEqual({ tableName: 'asc' })
    expect(schemas.take).toBeGreaterThanOrEqual(500)
  })
})
