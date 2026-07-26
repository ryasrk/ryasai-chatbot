import { mock } from 'bun:test'

export const mockExecuteRawUnsafe = mock<(sql: string, ...params: unknown[]) => Promise<number>>(async () => 1)

export const mockQueryRawUnsafe = mock(
  async (sql: string, ..._params: unknown[]): Promise<unknown[]> => {
    if (sql.includes('PRAGMA')) {
      return [
        { name: 'id', type: 'INTEGER', notnull: 1, pk: 1 },
        { name: 'name', type: 'TEXT', notnull: 0, pk: 0 },
      ]
    }
    if (sql.includes('information_schema.columns')) {
      return [
        { name: 'id', type: 'integer', notnull: 1, pk: 1 },
        { name: 'name', type: 'text', notnull: 0, pk: 0 },
      ]
    }
    if (sql.includes('COUNT(*)')) return [{ c: 5 }]
    if (sql.includes('DISTINCT')) return [{ v: 'active' }, { v: 'pending' }]
    if (sql.includes('LIMIT 1')) return [{ id: 1, name: 'sample' }]
    return []
  },
)

export const mockQueryRaw = mock(
  async (_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => [{ c: 1 }],
)
