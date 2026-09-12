/**
 * Driver-level tests for `src/lib/real-connectors.ts`.
 *
 * Scope: the class methods that talk to a driver — `fetchSchema()` and
 * `executeQuery()` for MySQL and ClickHouse — exercised through MOCK drivers.
 * No database is needed; the tests must pass on a bare machine.
 *
 * Why this file exists: the 327 uncovered lines in real-connectors.ts were
 * almost entirely these methods. `executeQuery` is the execution boundary
 * (assertSelectOnly + assertNoDangerousFunctions + DB-layer read-only), so a
 * regression here is a security regression, and it was untested.
 *
 * Separate file: the existing coverage test mocks only 'mssql'. Adding mysql2 /
 * clickhouse mocks there would change the module graph it was written against.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// Mocks installed BEFORE importing the module under test, so the static
// `async () => import('mysql2/promise')` literals in DRIVER_LOADERS resolve here.
// ---------------------------------------------------------------------------
const my = {
  queryResults: [] as unknown[],
  connQueryResults: [] as unknown[],
  calls: [] as { sql: string; values?: unknown[] }[],
  connCalls: [] as string[],
  rollbackCalls: 0,
  releaseCalls: 0,
  commitCalls: 0,
  queryThrows: null as Error | null,
}

const fakeConn = {
  query: async (arg: unknown) => {
    const sql = typeof arg === 'string' ? arg : (arg as { sql: string }).sql
    my.connCalls.push(sql)
    if (my.queryThrows) throw my.queryThrows
    return [my.connQueryResults.shift() ?? [], []]
  },
  commit: async () => { my.commitCalls++ },
  rollback: async () => { my.rollbackCalls++ },
  release: () => { my.releaseCalls++ },
}

const fakeMysqlPool = {
  query: async (arg: unknown) => {
    const sql = typeof arg === 'string' ? arg : (arg as { sql: string }).sql
    my.calls.push({
      sql,
      values: typeof arg === 'string' ? undefined : (arg as { values?: unknown[] }).values,
    })
    if (my.queryThrows) throw my.queryThrows
    return [my.queryResults.shift() ?? [], []]
  },
  getConnection: async () => fakeConn,
  end: async () => {},
}

mock.module('mysql2/promise', () => ({ createPool: () => fakeMysqlPool }))

const ch = {
  queries: [] as string[],
  params: [] as Record<string, unknown>[],
  responseText: '',
  queryThrows: null as Error | null,
}
mock.module('@clickhouse/client', () => ({
  createClient: () => ({
    query: async (a: { query: string; query_params?: Record<string, unknown> }) => {
      ch.queries.push(a.query)
      ch.params.push(a.query_params ?? {})
      if (ch.queryThrows) throw ch.queryThrows
      return { text: async () => ch.responseText }
    },
    close: async () => {},
  }),
}))

import { ClickHouseConnector, MysqlConnector } from './real-connectors'

const MYSQL_CFG = { host: 'h', port: 3306, database: 'shop', user: 'u', password: 'p' }

beforeEach(() => {
  my.queryResults = []
  my.connQueryResults = []
  my.calls = []
  my.connCalls = []
  my.rollbackCalls = 0
  my.releaseCalls = 0
  my.commitCalls = 0
  my.queryThrows = null
  ch.queries = []
  ch.params = []
  ch.responseText = ''
  ch.queryThrows = null
})

// ---------------------------------------------------------------------------
// MysqlConnector.fetchSchema — catalog reflection
// ---------------------------------------------------------------------------
describe('MysqlConnector.fetchSchema', () => {
  test('binds the database as a PARAMETER, never interpolated into the SQL', async () => {
    await new MysqlConnector(MYSQL_CFG, 'MYSQL').fetchSchema()
    const tablesQuery = my.calls[0]
    // A quoted-in value would let a database name close the literal. mysql2
    // placeholders keep catalog metadata data, not SQL.
    expect(tablesQuery.sql).toContain('TABLE_SCHEMA = ?')
    expect(tablesQuery.sql).not.toContain("'shop'")
    expect(tablesQuery.values).toEqual(['shop'])
  })

  test('both reflection queries filter on the configured schema', async () => {
    my.queryResults = [
      [{ table_name: 'orders', row_count: 5 }],
      [{ table_name: 'orders', column_name: 'id', data_type: 'int', is_nullable: 'NO', is_pk: 1 }],
      [],
    ]
    await new MysqlConnector(MYSQL_CFG, 'MYSQL').fetchSchema()
    // 2 catalog queries; enrichSchema then adds one sample-row job for the table
    // (its only column is `int`, so no DISTINCT probe is queued).
    expect(my.calls).toHaveLength(3)
    expect(my.calls[0].values).toEqual(['shop'])
    expect(my.calls[1].values).toEqual(['shop', 'shop'])
    // The sample-row query is parameter-free and quotes the identifier.
    expect(my.calls[2].sql).toContain('FROM `orders` LIMIT 1')
  })

  test('rowCount 0 and >10000 tables are SKIPPED by enrichment', async () => {
    my.queryResults = [
      [{ table_name: 'empty', row_count: 0 }, { table_name: 'huge', row_count: 999999 }],
      [
        { table_name: 'empty', column_name: 'a', data_type: 'int', is_nullable: 'NO', is_pk: 1 },
        { table_name: 'huge', column_name: 'a', data_type: 'int', is_nullable: 'NO', is_pk: 1 },
      ],
      [],
    ]
    await new MysqlConnector(MYSQL_CFG, 'MYSQL').fetchSchema()
    // No sample-row probe for either: an empty table has nothing to sample and a
    // huge one is deliberately left alone (SELECT ... LIMIT 1 would be fine, but
    // the budget guard keeps large managed catalogs from stalling reflection).
    expect(my.calls).toHaveLength(2)
  })

  test('a TEXT column with a small row count gets a DISTINCT-value probe', async () => {
    my.queryResults = [
      [{ table_name: 'orders', row_count: 5 }],
      [{ table_name: 'orders', column_name: 'status', data_type: 'varchar', is_nullable: 'YES', is_pk: 0 }],
      [{ v: 'open' }, { v: 'closed' }],
      [],
    ]
    await new MysqlConnector(MYSQL_CFG, 'MYSQL').fetchSchema()
    const probe = my.calls.find((c) => c.sql.includes('SELECT DISTINCT'))
    expect(probe).toBeTruthy()
    // The identifier must be backtick-quoted (MySQL uses backticks, not quotes).
    expect(probe!.sql).toContain('`status`')
  })

  test('assembles tables with columns, PK and FK from the two result sets', async () => {
    my.queryResults = [
      [{ table_name: 'orders', row_count: 42 }],
      [
        { table_name: 'orders', column_name: 'id', data_type: 'int', is_nullable: 'NO', is_pk: 1, fk_ref_table: null, fk_ref_column: null },
        { table_name: 'orders', column_name: 'cust_id', data_type: 'int', is_nullable: 'YES', is_pk: 0, fk_ref_table: 'customers', fk_ref_column: 'id' },
      ],
      [],
    ]
    const tables = await new MysqlConnector(MYSQL_CFG, 'MYSQL').fetchSchema()
    expect(tables).toHaveLength(1)
    expect(tables[0].tableName).toBe('orders')
    expect(tables[0].rowCount).toBe(42)
    expect(tables[0].columns.map((c) => c.name)).toEqual(['id', 'cust_id'])
    const pk = tables[0].columns.find((c) => c.name === 'id')!
    // is_pk arrives as MySQL's 1/0, not a boolean — misreading it drops the PK.
    expect(pk.primaryKey).toBe(true)
    expect(pk.notNull).toBe(true)
  })

  test('a NULL row_count is coerced, not left as null or NaN', async () => {
    my.queryResults = [
      [{ table_name: 't', row_count: null }],
      [{ table_name: 't', column_name: 'id', data_type: 'int', is_nullable: 'NO', is_pk: 1 }],
      [],
    ]
    const tables = await new MysqlConnector(MYSQL_CFG, 'MYSQL').fetchSchema()
    // COALESCE in the query is the first line of defence; the assembler must not
    // pass null through, because rowCount feeds numeric comparisons downstream.
    expect(Number.isFinite(tables[0].rowCount)).toBe(true)
    expect(tables[0].rowCount).toBe(0)
  })

  test('an empty catalog returns [] rather than throwing', async () => {
    expect(await new MysqlConnector(MYSQL_CFG, 'MYSQL').fetchSchema()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// MysqlConnector.executeQuery — the execution boundary
// ---------------------------------------------------------------------------
describe('MysqlConnector.executeQuery', () => {
  test('a mutation is refused BEFORE the driver is ever touched', async () => {
    const c = new MysqlConnector(MYSQL_CFG, 'MYSQL')
    await expect(c.executeQuery('DELETE FROM orders')).rejects.toThrow()
    // The guardrail must run before a connection is checked out.
    expect(my.connCalls).toEqual([])
  })

  test('a side-effecting function is refused before execution', async () => {
    await expect(new MysqlConnector(MYSQL_CFG, 'MYSQL').executeQuery('SELECT LOAD_FILE("/etc/passwd")')).rejects.toThrow()
    expect(my.connCalls).toEqual([])
  })

  test('READ ONLY is set on the SAME connection that runs the query', async () => {
    my.connQueryResults = [[{ a: 1 }]]
    await new MysqlConnector(MYSQL_CFG, 'MYSQL').executeQuery('SELECT a FROM t LIMIT 1')
    // All three statements on one connection — a pooled per-call read-only would
    // not apply to the query that follows.
    expect(my.connCalls[0]).toBe('SET TRANSACTION READ ONLY')
    expect(my.connCalls[1]).toBe('START TRANSACTION READ ONLY')
    expect(my.connCalls[2]).toContain('SELECT a FROM t')
  })

  test('a successful query commits, releases, and reports rowCount + timing', async () => {
    my.connQueryResults = [[], [], [{ a: 1 }, { a: 2 }]]
    const r = await new MysqlConnector(MYSQL_CFG, 'MYSQL').executeQuery('SELECT a FROM t LIMIT 2')
    expect(r.rowCount).toBe(2)
    expect(r.rows).toHaveLength(2)
    expect(r.executionMs).toBeGreaterThanOrEqual(0)
    expect(my.commitCalls).toBe(1)
    expect(my.releaseCalls).toBe(1)
  })

  test('a driver failure rolls back AND still releases the connection', async () => {
    my.connQueryResults = [[], []]
    my.queryThrows = new Error('connection reset')
    const c = new MysqlConnector(MYSQL_CFG, 'MYSQL')
    await expect(c.executeQuery('SELECT a FROM t LIMIT 1')).rejects.toThrow('connection reset')
    // A leaked connection would exhaust the pool under repeated failure.
    expect(my.rollbackCalls).toBe(1)
    expect(my.releaseCalls).toBe(1)
    expect(my.commitCalls).toBe(0)
  })

  test('rows are normalised (Dates/Decimals become strings, not objects)', async () => {
    my.connQueryResults = [[], [], [{ when: new Date('2026-01-02T03:04:05Z'), n: 7 }]]
    const r = await new MysqlConnector(MYSQL_CFG, 'MYSQL').executeQuery('SELECT when, n FROM t LIMIT 1')
    expect(typeof r.rows[0].when).toBe('string')
    expect(r.rows[0].n).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// ClickHouseConnector — batch reflection + the known interpolation gap
// ---------------------------------------------------------------------------
describe('ClickHouseConnector.fetchSchema', () => {
  test('parses JSONEachRow output into tables with columns', async () => {
    ch.responseText = [
      JSON.stringify({ table_name: 'events', engine: 'MergeTree', col_name: 'id', col_type: 'UInt64', pk: 1 }),
      JSON.stringify({ table_name: 'events', engine: 'MergeTree', col_name: 'at', col_type: 'Nullable(DateTime)', pk: 0 }),
      JSON.stringify({ table_name: 'plain', engine: 'Log', col_name: null }),
    ].join('\n')
    const tables = await new ClickHouseConnector({ host: 'h', database: 'analytics' }, 'CLICKHOUSE').fetchSchema()
    expect(tables.map((t) => t.tableName).sort()).toEqual(['events', 'plain'])
    const events = tables.find((t) => t.tableName === 'events')!
    expect(events.columns).toHaveLength(2)
    expect(events.columns[0].primaryKey).toBe(true)
    // Nullable(...) in the type string is the only nullability signal here.
    expect(events.columns[0].notNull).toBe(true)
    expect(events.columns[1].notNull).toBe(false)
  })

  test('rowCount is 0 by design (playground query quota)', async () => {
    ch.responseText = JSON.stringify({ table_name: 't', engine: 'Log', col_name: 'a', col_type: 'String', pk: 0 })
    const tables = await new ClickHouseConnector({ host: 'h', database: 'd' }, 'CLICKHOUSE').fetchSchema()
    // Deliberately not counted; a COUNT(*) per table exhausted the quota.
    expect(tables[0].rowCount).toBe(0)
    expect(ch.queries[0]).not.toContain('count(')
  })

  test('MaterializedView tables are filtered out of the reflection query', async () => {
    ch.responseText = ''
    await new ClickHouseConnector({ host: 'h', database: 'd' }, 'CLICKHOUSE').fetchSchema()
    expect(ch.queries[0]).toContain("engine NOT LIKE '%Materialized%'")
  })

  // -------------------------------------------------------------------------
  // SECURITY (fixed): the database name is admin-settable from the integration
  // form, and this query used to interpolate it as a SQL literal, unlike every
  // other connector in this file. ClickHouse parameters keep it out of the SQL
  // text entirely.
  //
  // Verified by negative control: reverting to the interpolated form makes this
  // test fail (the hostile name reappears inside the query string).
  // -------------------------------------------------------------------------
  test('the database name is passed as a PARAMETER, never interpolated', async () => {
    ch.responseText = ''
    const hostile = "d' OR 1=1 --"
    await new ClickHouseConnector({ host: 'h', database: hostile }, 'CLICKHOUSE').fetchSchema()
    const q = ch.queries[0]
    // The hostile value must not appear in the SQL text AT ALL.
    expect(q).not.toContain("OR 1=1")
    expect(q).not.toContain(`'${hostile}'`)
    // And the placeholder + params carry it instead.
    expect(q).toContain('{db:String}')
    expect(ch.params[0]).toEqual({ db: hostile })
  })

  test('an ordinary database name still filters the reflection query', async () => {
    ch.responseText = ''
    await new ClickHouseConnector({ host: 'h', database: 'analytics' }, 'CLICKHOUSE').fetchSchema()
    // The parameterisation must not quietly stop filtering by schema.
    expect(ch.queries[0]).toContain('t.database = {db:String}')
    expect(ch.params[0]).toEqual({ db: 'analytics' })
  })
})

describe('ClickHouseConnector.executeQuery', () => {
  test('a mutation is refused before the client is used', async () => {
    await expect(new ClickHouseConnector({ host: 'h', database: 'd' }, 'CLICKHOUSE').executeQuery('DROP TABLE t')).rejects.toThrow()
    expect(ch.queries).toEqual([])
  })

  test('a successful select reports rows and timing', async () => {
    ch.responseText = [JSON.stringify({ a: 1 }), JSON.stringify({ a: 2 })].join('\n')
    const r = await new ClickHouseConnector({ host: 'h', database: 'd' }, 'CLICKHOUSE').executeQuery('SELECT a FROM t LIMIT 2')
    expect(r.rowCount).toBe(2)
    expect(r.rows[0].a).toBe(1)
  })

  test('an empty response body is zero rows, not a parse error', async () => {
    ch.responseText = '\n\n'
    const r = await new ClickHouseConnector({ host: 'h', database: 'd' }, 'CLICKHOUSE').executeQuery('SELECT a FROM t LIMIT 1')
    expect(r.rows).toEqual([])
    expect(r.rowCount).toBe(0)
  })
})
