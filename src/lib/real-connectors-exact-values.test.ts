import { describe, expect, mock, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Values reach the model EXACTLY as the datasource holds them.
//
// Every case here was found by running the real connectors against real servers
// (PostgreSQL 17, CockroachDB 24.3, MySQL 8.4, MariaDB 11.4) on a UTC+7 host, and
// each assertion is the measured failure turned around:
//   - DATE 2024-01-15 arrived as 2024-01-14T17:00:00.000Z, TIMESTAMP 13:45 as 06:45
//   - BIGINT 9007199254740993 arrived as 9007199254740992
//   - `WHERE "city" = 'Jakarta'` on MySQL returned 0 rows instead of 2
//   - "Unknown database" and MariaDB's GSSAPI answer were unclassified
//   - a mariadb:// connection string was silently ignored
//
// `pg` is the REAL driver here: the type-parser override has to work against the
// parser table node-postgres actually ships, not a stand-in. mysql2 is replaced
// only to capture the pool options and the connection event.
// ---------------------------------------------------------------------------

const mysqlCapture = {
  options: null as Record<string, unknown> | null,
  connectionHandlers: [] as Array<(c: unknown) => void>,
}
mock.module('mysql2/promise', () => ({
  createPool: (options: Record<string, unknown>) => {
    mysqlCapture.options = options
    mysqlCapture.connectionHandlers = []
    return {
      // mysql2's promise pool exposes the callback pool, an EventEmitter, as `.pool`.
      pool: { on: (event: string, fn: (c: unknown) => void) => { if (event === 'connection') mysqlCapture.connectionHandlers.push(fn) } },
      query: async () => [[], []],
      end: async () => {},
    }
  },
}))

const pg = await import('pg')
const {
  pgTypeOverrides,
  enableAnsiQuotes,
  MYSQL_EXACT_VALUES,
  MYSQL_ANSI_QUOTES,
  MysqlConnector,
  PostgresConnector,
  pgConnectionString,
  normaliseRow,
  describeConnectionError,
  parseConnectionString,
  readDbConfig,
} = await import('@/lib/real-connectors')

describe('PostgreSQL: DATE and TIMESTAMP are not shifted by the host time zone', () => {
  const parserFor = (oid: number) => {
    const { types } = pgTypeOverrides(pg as unknown as Record<string, unknown>) as {
      types: { getTypeParser: (oid: number, format?: string) => (v: string) => unknown }
    }
    return types.getTypeParser(oid, 'text')
  }

  test('a DATE is returned as the calendar day the server sent', () => {
    expect(parserFor(1082)('2024-01-15')).toBe('2024-01-15')
  })

  test('a TIMESTAMP (no zone) keeps its wall-clock time', () => {
    expect(parserFor(1114)('2024-02-01 13:45:00')).toBe('2024-02-01 13:45:00')
  })

  test('a TIMESTAMPTZ is still an instant: the driver default parser is kept', () => {
    // An instant has one correct UTC form, so it is the one type the shift never affected.
    const parsed = parserFor(1184)('2024-02-01 13:45:00+07')
    expect(parsed).toBeInstanceOf(Date)
    expect((parsed as Date).toISOString()).toBe('2024-02-01T06:45:00.000Z')
  })

  test('every other type is the driver default (ints stay ints, int8 stays a string)', () => {
    expect(parserFor(23)('42')).toBe(42)
    expect(parserFor(20)('9007199254740993')).toBe('9007199254740993')
  })

  test('a pg namespace without a type table adds nothing, rather than breaking the pool', () => {
    expect(pgTypeOverrides({ Pool: class {} })).toEqual({})
  })

  test('the connector POOL is built with the override (wiring, not just the helper)', async () => {
    // Constructing a pg Pool does not connect, so this reads the options the real driver will use.
    const c = new PostgresConnector({ host: '127.0.0.1', port: 1, database: 'd', user: 'u', password: 'p' }, 'POSTGRESQL')
    const pool = (await (c as unknown as { pool(): Promise<{ options: { types?: { getTypeParser: (o: number, f?: string) => (v: string) => unknown } } }> }).pool())
    expect(pool.options.types?.getTypeParser(1082, 'text')('2024-01-15')).toBe('2024-01-15')
    await c.close()
  })
})

describe('MySQL / MariaDB: exact values and standard identifier quoting', () => {
  test('the pool keeps dates as strings and big integers exact, without turning every count into a string', async () => {
    expect(MYSQL_EXACT_VALUES).toEqual({ dateStrings: true, supportBigNumbers: true })
    const c = new MysqlConnector({ host: 'h', port: 3306, database: 'shop', user: 'u', password: 'p' }, 'MYSQL')
    await c.testConnection()
    expect(mysqlCapture.options?.dateStrings).toBe(true)
    expect(mysqlCapture.options?.supportBigNumbers).toBe(true)
    // bigNumberStrings would make COUNT(*) a string, and the chart builder needs numbers.
    expect(mysqlCapture.options?.bigNumberStrings).toBeUndefined()
    await c.close()
  })

  test('every new connection is switched to ANSI_QUOTES before it is used', async () => {
    const c = new MysqlConnector({ host: 'h', port: 3306, database: 'shop', user: 'u', password: 'p' }, 'MYSQL')
    await c.testConnection()
    expect(mysqlCapture.connectionHandlers.length).toBe(1)

    const sent: string[] = []
    mysqlCapture.connectionHandlers[0]({ query: (sql: string, cb: (e: unknown) => void) => { sent.push(sql); cb(null) } })
    expect(sent).toEqual([MYSQL_ANSI_QUOTES])
    // Appended to the session's existing modes, never replacing them (STRICT_TRANS_TABLES etc. stay).
    expect(MYSQL_ANSI_QUOTES).toContain('@@SESSION.sql_mode')
    expect(MYSQL_ANSI_QUOTES).toContain("'ANSI_QUOTES'")
    await c.close()
  })

  test('a server that refuses the mode, or a connection that throws, is not an error', () => {
    const handlers: Array<(c: unknown) => void> = []
    enableAnsiQuotes({ pool: { on: (_e: string, fn: (c: unknown) => void) => handlers.push(fn) } })
    expect(() => handlers[0]({ query: (_s: string, cb: (e: unknown) => void) => cb(new Error('ER_WRONG_VALUE_FOR_VAR')) })).not.toThrow()
    expect(() => handlers[0]({ query: () => { throw new Error('closed') } })).not.toThrow()
  })

  test('a pool without a connection event is left alone', () => {
    expect(() => enableAnsiQuotes({})).not.toThrow()
    expect(() => enableAnsiQuotes(null)).not.toThrow()
  })
})

describe('normaliseRow: a BigInt beyond 2^53 keeps every digit', () => {
  test('a safe BigInt is still a number', () => {
    expect(normaliseRow({ n: BigInt(42) }).n).toBe(42)
  })

  test('an unsafe BigInt becomes its exact decimal string, not a rounded number', () => {
    expect(normaliseRow({ id: BigInt('9007199254740993') }).id).toBe('9007199254740993')
    expect(normaliseRow({ id: BigInt('-9007199254740993') }).id).toBe('-9007199254740993')
  })
})

describe('describeConnectionError: the MySQL-family messages are classified', () => {
  test("mysql2's \"Unknown database 'x'\" is a missing database (the errno is not in the message)", () => {
    expect(describeConnectionError(new Error("Unknown database 'no_such_db'"), 'MYSQL').reason).toBe('database_missing')
  })

  test("MariaDB's GSSAPI answer to a rejected password is an authentication failure", () => {
    const d = describeConnectionError(
      new Error('Server requests authentication using unknown plugin auth_gssapi_client. See TROUBLESHOOTING.md'),
      'MYSQL',
    )
    expect(d.reason).toBe('auth')
    expect(d.message).toContain('GSSAPI')
  })

  test('the PostgreSQL forms still classify as before', () => {
    expect(describeConnectionError(new Error('database "x" does not exist'), 'POSTGRESQL').reason).toBe('database_missing')
    expect(describeConnectionError(new Error('password authentication failed for user "u"'), 'POSTGRESQL').reason).toBe('auth')
  })
})

describe('a mariadb:// connection string is understood', () => {
  test('it parses like mysql://', () => {
    expect(parseConnectionString('mariadb://root:s%40cret@db.local:3307/shop')).toEqual({
      host: 'db.local', port: 3307, database: 'shop', user: 'root', password: 's@cret', ssl: undefined, schema: undefined,
    })
  })

  test('so the fields come from it instead of silently falling back to localhost:0 with no database', () => {
    const c = readDbConfig({ connectionString: 'mariadb://root:pw@127.0.0.1:53307/dstest' })
    expect([c.host, c.port, c.database, c.user]).toEqual(['127.0.0.1', 53307, 'dstest', 'root'])
  })

  test('an unknown scheme is still refused', () => {
    expect(parseConnectionString('oracle://u:p@h:1521/svc')).toBeNull()
  })
})

describe('a connection string cannot override the connector\'s own TLS settings', () => {
  // MEASURED: `pg` merges a parsed connection string OVER the explicit options, and `sslmode=require` parses to
  // `ssl: {}` — so a Supabase/Neon-style string silently discarded `DB_SSL_REJECT_UNAUTHORIZED=0`, while the same
  // server configured field by field connected.
  test('sslmode is removed when the connector has decided on TLS itself', () => {
    expect(pgConnectionString('postgresql://u:p@h:6543/postgres?sslmode=require', true)).toBe('postgresql://u:p@h:6543/postgres')
  })

  test('every other parameter, and percent-encoded credentials, survive untouched', () => {
    const out = pgConnectionString('postgresql://postgres.ref:p%40ss%3Aw@h:6543/db?sslmode=require&channel_binding=require&application_name=x', true)
    expect(out).toBe('postgresql://postgres.ref:p%40ss%3Aw@h:6543/db?channel_binding=require&application_name=x')
  })

  test('sslmode=disable is the user turning TLS off, so it is passed through', () => {
    const s = 'postgresql://u:p@h/db?sslmode=disable'
    expect(pgConnectionString(s, true)).toBe(s)
  })

  test('without TLS, and without any TLS parameter, the string is unchanged', () => {
    expect(pgConnectionString('postgresql://u:p@h/db?sslmode=require', false)).toBe('postgresql://u:p@h/db?sslmode=require')
    expect(pgConnectionString('postgresql://u:p@h/db', true)).toBe('postgresql://u:p@h/db')
  })

  test('the POOL receives the cleaned string, with the connector\'s ssl object intact (wiring)', async () => {
    const c = new PostgresConnector({ connectionString: 'postgresql://u:p@db.example.com:6543/postgres?sslmode=require' }, 'SUPABASE')
    const pool = await (c as unknown as { pool(): Promise<{ options: { connectionString?: string; ssl?: unknown } }> }).pool()
    expect(pool.options.connectionString).toBe('postgresql://u:p@db.example.com:6543/postgres')
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: true })
    await c.close()
  })
})

describe('PgBouncer\'s missing-database message is classified', () => {
  test('"no such database: x" (PgBouncer 1.24, as in front of Supabase/Neon-style poolers)', () => {
    expect(describeConnectionError(new Error('no such database: no_such_db'), 'SUPABASE').reason).toBe('database_missing')
  })
})
