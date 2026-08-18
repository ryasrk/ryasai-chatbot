import { describe, expect, test } from 'bun:test'
import {
  withSqlConcurrency,
  buildChartDataFromRows,
  buildDocumentCitation,
  sanitizeSqlError,
  summarize,
  stripSessionWrapper,
  safeJson,
  safeParseColumns,
  safeParseSampleRow,
  extractTableName,
  jsonRowsToChart,
  unavailableDataSourceResult,
} from './tool-utils'

describe('tool-utils — withSqlConcurrency', () => {
  test('runs async function and returns result', async () => {
    const result = await withSqlConcurrency('test-int-1', async () => 42)
    expect(result).toBe(42)
  })

  test('propagates errors', async () => {
    expect(
      withSqlConcurrency('test-int-2', async () => { throw new Error('boom') }),
    ).rejects.toThrow('boom')
  })

  test('allows parallel calls up to 3', async () => {
    const order: number[] = []
    const tasks = Array.from({ length: 3 }, (_, i) =>
      withSqlConcurrency('test-int-3', async () => {
        order.push(i)
        await new Promise((r) => setTimeout(r, 50))
        return i
      }),
    )
    const results = await Promise.all(tasks)
    expect(results).toEqual([0, 1, 2])
    expect(order).toEqual([0, 1, 2])
  })

  test('queues 4th call until one finishes', async () => {
    const tasks = Array.from({ length: 4 }, (_, i) =>
      withSqlConcurrency('test-int-4', async () => {
        await new Promise((r) => setTimeout(r, 30))
        return i
      }),
    )
    const results = await Promise.all(tasks)
    expect(results).toEqual([0, 1, 2, 3])
  })
})

describe('tool-utils — buildChartDataFromRows', () => {
  test('null/empty → null', () => {
    expect(buildChartDataFromRows([])).toBeNull()
    expect(buildChartDataFromRows(null as unknown as [])).toBeNull()
  })

  test('single row → null (need >=2)', () => {
    expect(buildChartDataFromRows([{ a: 1 }])).toBeNull()
  })

  test('single column → null (need >=2)', () => {
    expect(buildChartDataFromRows([{ a: 1 }, { a: 2 }])).toBeNull()
  })

  test('category + numeric → bar chart', () => {
    const rows = [
      { name: 'Alice', score: 90 },
      { name: 'Bob', score: 85 },
    ]
    const chart = buildChartDataFromRows(rows)
    expect(chart).not.toBeNull()
    expect(chart!.type).toBe('bar')
    expect(chart!.xKey).toBe('name')
    expect(chart!.yKeys).toContain('score')
  })

  test('date + numeric → line chart', () => {
    const rows = [
      { date: '2024-01-01', value: 100 },
      { date: '2024-02-01', value: 200 },
    ]
    const chart = buildChartDataFromRows(rows)
    expect(chart).not.toBeNull()
    expect(chart!.type).toBe('line')
    expect(chart!.xKey).toBe('date')
  })

  test('all numeric columns → null (no x-axis)', () => {
    const rows = [
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ]
    const chart = buildChartDataFromRows(rows)
    expect(chart).toBeNull()
  })
})

describe('tool-utils — buildDocumentCitation', () => {
  test('creates citation with snippet', () => {
    const cit = buildDocumentCitation({
      documentName: 'report.pdf',
      chunkIndex: 3,
      content: 'This is the content.',
      score: 0.92,
    })
    expect(cit.type).toBe('DOCUMENT')
    expect(cit.source).toBe('report.pdf')
    expect(cit.chunkIndex).toBe(3)
    expect(cit.score).toBe(0.92)
    expect(cit.snippet).toBe('This is the content.')
  })

  test('truncates long content', () => {
    const long = 'x'.repeat(300)
    const cit = buildDocumentCitation({
      documentName: 'doc.pdf',
      chunkIndex: 0,
      content: long,
      score: 1.0,
    })
    expect(cit.snippet!.length).toBeLessThan(250)
    expect(cit.snippet!.endsWith('...')).toBe(true)
  })
})

describe('tool-utils — sanitizeSqlError', () => {
  test('strips postgres connection strings', () => {
    const msg = 'Connection failed: postgres://user:pass@host:5432/db'
    expect(sanitizeSqlError(msg)).toBe('Connection failed: postgres://***')
  })

  test('strips mysql connection strings', () => {
    const msg = 'Error: mysql://root:secret@localhost/db'
    expect(sanitizeSqlError(msg)).toBe('Error: mysql://***')
  })

  test('strips password= and user= params', () => {
    const msg = 'connection string: password=secret user=admin host=localhost'
    const sanitized = sanitizeSqlError(msg)
    expect(sanitized).not.toContain('secret')
    expect(sanitized).not.toContain('admin')
    expect(sanitized).toContain('password=***')
    expect(sanitized).toContain('user=***')
  })

  test('truncates to 300 chars', () => {
    const long = 'x'.repeat(500)
    expect(sanitizeSqlError(long).length).toBe(300)
  })
})

describe('tool-utils — summarize', () => {
  test('short text → unchanged', () => {
    expect(summarize('hello')).toBe('hello')
  })

  test('long text → truncated with ...', () => {
    const long = 'x'.repeat(1500)
    const result = summarize(long)
    expect(result.length).toBe(1003)
    expect(result.endsWith('...')).toBe(true)
  })

  test('exactly 1000 chars → unchanged', () => {
    const exact = 'x'.repeat(1000)
    expect(summarize(exact)).toBe(exact)
  })
})

describe('tool-utils — stripSessionWrapper', () => {
  // ponytail: recall/rewrite do string+semantic matching — the send route's
  // meta-wrapper must not leak into those queries.
  test('strips full session wrapper (start + current time)', () => {
    const wrapped = '[Session started: Aug 15, 2026, 09:00 WIB] [Current time: Aug 15, 2026, 10:30 WIB]\n\nBerapa total pendapatan Q1?'
    expect(stripSessionWrapper(wrapped)).toBe('Berapa total pendapatan Q1?')
  })

  test('strips lone session-start wrapper', () => {
    const wrapped = '[Session started: Aug 15, 2026, 09:00 WIB]\n\nHalo, tanya data'
    expect(stripSessionWrapper(wrapped)).toBe('Halo, tanya data')
  })

  test('plain text passes through unchanged', () => {
    expect(stripSessionWrapper('plain question')).toBe('plain question')
  })
})

describe('tool-utils — safeJson', () => {
  test('valid JSON → parsed', () => {
    expect(safeJson('{"a":1}')).toEqual({ a: 1 })
  })

  test('invalid JSON → null', () => {
    expect(safeJson('not json')).toBeNull()
  })

  test('empty string → null', () => {
    expect(safeJson('')).toBeNull()
  })
})

describe('tool-utils — safeParseColumns', () => {
  test('valid column array → parsed', () => {
    const raw = JSON.stringify([
      { name: 'id', type: 'INTEGER', primaryKey: true },
      { name: 'name', type: 'TEXT' },
    ])
    const cols = safeParseColumns(raw)
    expect(cols).toHaveLength(2)
    expect(cols[0].name).toBe('id')
    expect(cols[0].primaryKey).toBe(true)
  })

  test('invalid JSON → empty array', () => {
    expect(safeParseColumns('not json')).toEqual([])
  })

  test('non-array JSON → empty array', () => {
    expect(safeParseColumns('{"a":1}')).toEqual([])
  })
})

describe('tool-utils — safeParseSampleRow', () => {
  test('valid object → parsed', () => {
    const raw = JSON.stringify({ id: 1, name: 'Alice' })
    expect(safeParseSampleRow(raw)).toEqual({ id: 1, name: 'Alice' })
  })

  test('null → undefined', () => {
    expect(safeParseSampleRow(null)).toBeUndefined()
  })

  test('array → undefined', () => {
    expect(safeParseSampleRow('[1,2,3]')).toBeUndefined()
  })

  test('invalid JSON → undefined', () => {
    expect(safeParseSampleRow('not json')).toBeUndefined()
  })
})

describe('tool-utils — extractTableName', () => {
  test('SELECT FROM table → table', () => {
    expect(extractTableName('SELECT * FROM users')).toBe('users')
  })

  test('SELECT FROM schema.table → table', () => {
    expect(extractTableName('SELECT * FROM public.users')).toBe('public')
  })

  test('JOIN table → table', () => {
    expect(extractTableName('SELECT * FROM a JOIN b ON 1=1')).toBe('a')
  })

  test('quoted table name → unquoted', () => {
    expect(extractTableName('SELECT * FROM "my table"')).toBe('my')
  })

  test('no FROM → "query"', () => {
    expect(extractTableName('SELECT 1')).toBe('query')
  })
})

describe('tool-utils — jsonRowsToChart', () => {
  test('array of objects → chart data', () => {
    const data = [
      { name: 'A', val: 10 },
      { name: 'B', val: 20 },
    ]
    const chart = jsonRowsToChart(data)
    expect(chart).not.toBeNull()
    expect(chart!.data).toEqual(data)
  })

  test('object with data property → chart data', () => {
    const wrapped = { data: [{ name: 'A', val: 1 }, { name: 'B', val: 2 }] }
    const chart = jsonRowsToChart(wrapped)
    expect(chart).not.toBeNull()
  })

  test('non-array, non-object → null', () => {
    expect(jsonRowsToChart('hello')).toBeNull()
  })

  test('array of primitives → null', () => {
    expect(jsonRowsToChart([1, 2, 3])).toBeNull()
  })
})

describe('tool-utils — unavailableDataSourceResult', () => {
  test('returns blocked result', () => {
    const result = unavailableDataSourceResult('SQL', 'test query', Date.now())
    expect(result.answer).toContain('not yet available')
    expect(result.toolRuns).toHaveLength(1)
    expect(result.toolRuns[0].status).toBe('blocked')
    expect(result.toolRuns[0].type).toBe('SQL')
  })
})
