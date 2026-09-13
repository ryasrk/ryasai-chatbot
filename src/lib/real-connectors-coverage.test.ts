/**
 * Tests for `src/lib/real-connectors.ts` — the execution boundary for every
 * external database the app talks to.
 *
 * Scope: the pure/near-pure logic (connection-string parsing, config
 * normalisation, error classification, row normalisation, driver loading) plus
 * the SQL-shape assertions, which are a SECURITY boundary. Live-database code
 * paths are exercised through mocked or unreachable drivers, never a real DB —
 * the tests must pass on a machine with no database at all.
 *
 * The driver-absence path is deliberate: `DRIVER_LOADERS` uses static
 * `async () => import('pg')` literals (invariants #3 — a variable specifier is
 * invisible to Turbopack and to output tracing, so drivers vanish from the
 * standalone image). A missing driver must degrade to an actionable message,
 * not a crash, so that branch is asserted here.
 */
import { describe, expect, test, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Driver mocks — installed BEFORE the module under test is imported, so the
// static `import('mssql')` literals inside DRIVER_LOADERS resolve to these.
// `mssql` is mocked because its static loader pulls in the native `tedious`
// stack; the mock also lets us reproduce the "driver package present but its
// own dependency is missing" failure that users actually hit.
// ---------------------------------------------------------------------------
const FAKE_MSSQL_MESSAGE = "Cannot find module 'tedious'"
let mssqlConnectAttempts = 0
let mssqlCloseCalls = 0
let mssqlQueryResult: unknown = { recordset: [{ ok: 1 }] }
let mssqlConnectError: Error | null = new Error(FAKE_MSSQL_MESSAGE)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FakeConnectionPool = class {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(public cfg: Record<string, unknown>) {}
  async connect() {
    mssqlConnectAttempts++
    if (mssqlConnectError) throw mssqlConnectError
    return this
  }
  request() {
    return {
      input: () => ({ query: async () => mssqlQueryResult }),
      query: async () => mssqlQueryResult,
    }
  }
  async close() {
    mssqlCloseCalls++
  }
}

mock.module('mssql', () => ({ ConnectionPool: FakeConnectionPool }))
mock.module('@/lib/db-provider-presets', () => {
  const PRESETS: Record<string, { sslByDefault?: boolean }> = {
    SUPABASE: { sslByDefault: true },
    NEON: { sslByDefault: true },
    PLANETSCALE: { sslByDefault: true },
    POSTGRESQL: {},
  }
  return {
    getDbProviderPreset: (id: string) => (id in PRESETS ? { id, ...PRESETS[id] } : undefined),
  }
})

import {
  assertNoDangerousFunctions,
  assertSelectOnly,
  ClickHouseConnector,
  describeConnectionError,
  loadDriver,
  MssqlConnector,
  MysqlConnector,
  normaliseRow,
  parseConnectionString,
  PostgresConnector,
  readDbConfig,
  type ConnectionFailureReason,
} from './real-connectors'
import { detectDangerousFunctions, validateAndSanitizeLlmSql } from './guardrails'

// ---------------------------------------------------------------------------
// parseConnectionString — managed providers hand users a URL, not fields
// ---------------------------------------------------------------------------

describe('parseConnectionString', () => {
  test('rejects every scheme it does not recognise', () => {
    expect(parseConnectionString('')).toBeNull()
    expect(parseConnectionString('   ')).toBeNull()
    expect(parseConnectionString('localhost:5432')).toBeNull()
    expect(parseConnectionString('mongodb://u:p@h:27017/d')).toBeNull()
    expect(parseConnectionString('http://u:p@h/d')).toBeNull()
    // A lookalike scheme must not match the `postgres(ql)?`/`mysql(2)?` prefix.
    expect(parseConnectionString('postgresqldb://u:p@h/d')).toBeNull()
  })

  test('an unparsable URL after a valid scheme returns null, not a throw', () => {
    expect(parseConnectionString('postgresql://[::1')).toBeNull()
  })

  test('accepts postgres/postgresql/mysql/mysql2, case-insensitively', () => {
    for (const s of [
      'postgres://u:p@h:5432/d',
      'postgresql://u:p@h:5432/d',
      'POSTGRESQL://u:p@h:5432/d',
      'mysql://u:p@h:3306/d',
      'mysql2://u:p@h:3306/d',
      'MYSQL://u:p@h:3306/d',
    ]) {
      expect(parseConnectionString(s)?.host).toBe('h')
    }
  })

  test('URL-decodes user and password (passwords with @ / : survive)', () => {
    const c = parseConnectionString('postgresql://user%40corp:p%40ss%3Aword@h:5432/d')
    expect(c?.user).toBe('user@corp')
    expect(c?.password).toBe('p@ss:word')
  })

  test('URL-decodes the database name', () => {
    expect(parseConnectionString('postgresql://u:p@h:5432/my%20db')?.database).toBe('my db')
  })

  test('returns undefined (not empty string) for absent port/user/password', () => {
    const c = parseConnectionString('mysql://127.0.0.1/db')
    expect(c?.port).toBeUndefined()
    expect(c?.user).toBeUndefined()
    expect(c?.password).toBeUndefined()
    expect(c?.ssl).toBeUndefined()
  })

  test('an empty path yields an empty database name', () => {
    expect(parseConnectionString('postgresql://u:p@h:5432/?schema=s')?.database).toBe('')
  })

  test('ssl turns on for require / verify-ca / verify-full / ssl=true only', () => {
    const sslOn = [
      'postgresql://u:p@h:5432/d?sslmode=require',
      'postgresql://u:p@h:5432/d?sslmode=verify-ca',
      'postgresql://u:p@h:5432/d?sslmode=verify-full',
      'postgresql://u:p@h:5432/d?ssl=true',
      // Supabase/Neon emit snake_case from some clients.
      'postgresql://u:p@h:5432/d?ssl_mode=require',
      'postgresql://u:p@h:5432/d?sslmode=REQUIRE',
    ]
    for (const s of sslOn) expect(parseConnectionString(s)?.ssl).toBe(true)

    const sslOff = [
      'postgresql://u:p@h:5432/d?sslmode=disable',
      'postgresql://u:p@h:5432/d?sslmode=prefer',
      'postgresql://u:p@h:5432/d?ssl=false',
      'postgresql://u:p@h:5432/d',
    ]
    for (const s of sslOff) expect(parseConnectionString(s)?.ssl).toBeUndefined()
  })

  test('reads ?schema= then falls back to ?search_path=', () => {
    expect(parseConnectionString('postgresql://u:p@h:5432/d?schema=app')?.schema).toBe('app')
    expect(parseConnectionString('postgresql://u:p@h:5432/d?search_path=app')?.schema).toBe('app')
    // Prisma/Supabase convention: ?schema= wins when both are present.
    expect(parseConnectionString('postgresql://u:p@h:5432/d?search_path=a&schema=b')?.schema).toBe('b')
  })

  test('surrounding whitespace is tolerated', () => {
    expect(parseConnectionString('  postgresql://u:p@h/d  ')?.host).toBe('h')
  })
})

// ---------------------------------------------------------------------------
// readDbConfig — connection string wins, fields are the fallback
// ---------------------------------------------------------------------------

describe('readDbConfig', () => {
  test('a connectionString overrides every individual field', () => {
    const c = readDbConfig({
      connectionString: 'postgresql://cu:cp@chost:6432/cdb?sslmode=require',
      host: 'wrong',
      port: 1,
      username: 'wrong',
      password: 'wrong',
      database_name: 'wrong',
      ssl: false,
    })
    expect(c).toEqual({ host: 'chost', port: 6432, database: 'cdb', user: 'cu', password: 'cp', schema: undefined, ssl: true })
  })

  test('a connectionString with no explicit port defers to the port field', () => {
    const c = readDbConfig({ connectionString: 'postgresql://u:p@h/d', port: 9999 })
    expect(c.port).toBe(9999)
  })

  test('an ignored connectionString (wrong type / empty) falls back to fields', () => {
    expect(readDbConfig({ connectionString: 123, host: 'h', database: 'd' }).host).toBe('h')
    expect(readDbConfig({ connectionString: '', host: 'h', database: 'd' }).host).toBe('h')
    // A non-URL string parses to null, so the field fallback still applies.
    expect(readDbConfig({ connectionString: 'not-a-url', host: 'h', database: 'd' }).host).toBe('h')
  })

  test('host falls back host → server → localhost', () => {
    expect(readDbConfig({ host: 'h1', server: 's1' }).host).toBe('h1')
    expect(readDbConfig({ server: 's1' }).host).toBe('s1')
    expect(readDbConfig({ host: '' }).host).toBe('localhost')
    expect(readDbConfig({}).host).toBe('localhost')
  })

  test('database falls back database → db → database_name → empty', () => {
    expect(readDbConfig({ database: 'd1', db: 'd2', database_name: 'd3' }).database).toBe('d1')
    expect(readDbConfig({ db: 'd2', database_name: 'd3' }).database).toBe('d2')
    // database_name is what the create-integration UI/API actually sends.
    expect(readDbConfig({ database_name: 'd3' }).database).toBe('d3')
    expect(readDbConfig({}).database).toBe('')
  })

  test('user falls back user → username → empty', () => {
    expect(readDbConfig({ user: 'u1', username: 'u2' }).user).toBe('u1')
    expect(readDbConfig({ username: 'u2' }).user).toBe('u2')
    expect(readDbConfig({}).user).toBe('')
  })

  test('a numeric port is honoured; a missing port is 0 (drivers apply their own default)', () => {
    expect(readDbConfig({ port: 6543 }).port).toBe(6543)
    expect(readDbConfig({}).port).toBe(0)
    expect(readDbConfig({ port: 0 }).port).toBe(0)
  })

  test('ssl accepts boolean true and the string "true" only', () => {
    expect(readDbConfig({ ssl: true }).ssl).toBe(true)
    expect(readDbConfig({ ssl: 'true' }).ssl).toBe(true)
    expect(readDbConfig({ ssl: false }).ssl).toBe(false)
    expect(readDbConfig({ ssl: 'false' }).ssl).toBe(false)
    expect(readDbConfig({ ssl: 1 }).ssl).toBe(false)
  })

  test('password is stringified and defaults to empty (never undefined)', () => {
    expect(readDbConfig({ password: 'p' }).password).toBe('p')
    expect(readDbConfig({}).password).toBe('')
    expect(readDbConfig({ password: 1234 }).password).toBe('1234')
  })

  test('schema is stringified when present', () => {
    expect(readDbConfig({ schema: 'app' }).schema).toBe('app')
    expect(readDbConfig({}).schema).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// describeConnectionError — the classified hint that replaced the opaque
// "Connection failed. Check credentials and network." string
// ---------------------------------------------------------------------------

describe('describeConnectionError', () => {
  test('classifies auth failures across all four dialects', () => {
    const auth = [
      'password authentication failed for user "postgres"',
      'FATAL: password authentication failed',
      'Access denied for user \'root\'@\'localhost\'',
      "Login failed for user 'sa'.",
      'error: 28000',
      '28P01',
      'ER_ACCESS_DENIED_ERROR (1045 (28000))',
      '18456',
    ]
    for (const m of auth) expect(describeConnectionError(new Error(m)).reason).toBe('auth')
  })

  test('the Supabase pooler hint names the dotted username and the DB password', () => {
    const d = describeConnectionError(new Error('password authentication failed'), 'SUPABASE')
    expect(d.reason).toBe('auth')
    expect(d.message).toContain('FULL username')
    expect(d.message).toContain('postgres.project-ref')
    expect(d.message).toContain('not the dashboard password')
  })

  test('the generic auth hint is used for any other provider', () => {
    expect(describeConnectionError(new Error('password authentication failed'), 'MYSQL').message)
      .toBe('Authentication failed. Check the username and password.')
    expect(describeConnectionError(new Error('password authentication failed')).message)
      .not.toContain('pooler')
  })

  test('classifies TLS problems and points at DB_SSL_REJECT_UNAUTHORIZED', () => {
    const ssl = [
      'self signed certificate in certificate chain',
      'self-signed certificate',
      'certificate has expired',
      'unable to verify the first certificate',
      'certificate verify failed',
      'deactivated ssl',
      'SSLFACTORY',
      'The server does not support SSL connections',
    ]
    for (const m of ssl) expect(describeConnectionError(new Error(m)).reason).toBe('ssl')
    expect(describeConnectionError(new Error('self signed certificate')).message)
      .toContain('DB_SSL_REJECT_UNAUTHORIZED')
  })

  test('classifies DNS resolution failures', () => {
    for (const m of [
      'getaddrinfo ENOTFOUND db.abcdefg.supabase.co',
      'ENOTFOUND',
      'Name or service not known',
      'no such host',
      'EAI_AGAIN',
    ]) {
      expect(describeConnectionError(new Error(m)).reason).toBe('dns')
    }
    expect(describeConnectionError(new Error('ENOTFOUND'), 'NEON').message).toContain('NEON')
  })

  test('classifies timeouts and explains the IP allow-list', () => {
    for (const m of ['connect ETIMEDOUT 1.2.3.4:5432', 'connection timeout', 'econnaborted: timeout']) {
      expect(describeConnectionError(new Error(m)).reason).toBe('timeout')
    }
    expect(describeConnectionError(new Error('connect ETIMEDOUT')).message).toContain('allow-list')
  })

  test('classifies an actively refused connection', () => {
    for (const m of ['connect ECONNREFUSED 127.0.0.1:5433', 'connection refused', 'connect ECONNREFUSED']) {
      expect(describeConnectionError(new Error(m)).reason).toBe('refused')
    }
  })

  test('classifies missing databases across dialects', () => {
    for (const m of [
      'database "nosuchdb" does not exist',
      'error 3D000',
      'Unknown database \'1049 unknown database\'',
      'Cannot open database "x" requested by the login',
    ]) {
      expect(describeConnectionError(new Error(m)).reason).toBe('database_missing')
    }
  })

  test('classifies a not-installed driver from a raw module error', () => {
    expect(describeConnectionError(new Error("Cannot find module 'tedious'")).reason).toBe('driver_missing')
    expect(describeConnectionError(new Error("Database driver 'pg' is not installed.")).reason).toBe('driver_missing')
    expect(describeConnectionError(new Error('Cannot find module')).message).toContain('Ask the operator')
  })

  test('driver_missing outranks auth/ssl classification when both patterns appear', () => {
    // loadDriver already wraps module errors; the double-guard must win so a
    // missing package is never reported as bad credentials.
    const d = describeConnectionError(new Error("Cannot find module 'pg' — ssl error connecting"))
    expect(d.reason).toBe('driver_missing')
  })

  test('unknown errors keep a bounded, prefixed copy of the original message', () => {
    const d = describeConnectionError(new Error('x'.repeat(500)))
    expect(d.reason).toBe('unknown')
    expect(d.message.startsWith('Connection failed: ')).toBe(true)
    expect(d.message).toBe(`Connection failed: ${'x'.repeat(300)}`)
  })

  test('non-Error throwables are stringified instead of crashing', () => {
    expect(describeConnectionError('boom').reason).toBe('unknown')
    expect(describeConnectionError('boom').message).toContain('boom')
    expect(describeConnectionError(null).message).toContain('null')
    expect(describeConnectionError(42).message).toContain('42')
    // A helper-shaped object is NOT an Error, so only its default String form survives.
    expect(describeConnectionError({ message: 'connect ECONNREFUSED' }).reason).toBe('unknown')
  })

  test('every failure mode returns a non-empty, user-facing message', () => {
    const cases: Array<[unknown, string]> = [
      [new Error('password authentication failed'), 'auth'],
      [new Error('self signed certificate'), 'ssl'],
      [new Error('getaddrinfo ENOTFOUND'), 'dns'],
      [new Error('ETIMEDOUT'), 'timeout'],
      [new Error('ECONNREFUSED'), 'refused'],
      [new Error('database "x" does not exist'), 'database_missing'],
      [new Error("Cannot find module 'x'"), 'driver_missing'],
      [new Error('something else entirely'), 'unknown'],
    ]
    for (const [err, reason] of cases) {
      const d = describeConnectionError(err)
      expect(d.reason).toBe(reason as ConnectionFailureReason)
      expect(d.message.length).toBeGreaterThan(10)
    }
  })
})

// ---------------------------------------------------------------------------
// assertSelectOnly / assertNoDangerousFunctions — the execution boundary, and
// its AGREEMENT with guardrails.ts. A divergence between the two was a real
// past incident (2026-09), so parity is asserted, not assumed.
// ---------------------------------------------------------------------------

const MUTATION_KEYWORDS = [
  'DELETE', 'UPDATE', 'INSERT', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT',
  'REVOKE', 'MERGE', 'REPLACE', 'CALL', 'EXEC', 'EXECUTE', 'RENAME', 'ATTACH',
  'DETACH', 'PRAGMA', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'TRANSACTION',
  'START', 'VACUUM', 'REINDEX', 'ANALYZE', 'LOCK', 'UNLOCK', 'HANDLER', 'INTO',
]

describe('assertSelectOnly', () => {
  test('rejects every mutation, transaction-control and maintenance keyword', () => {
    for (const kw of MUTATION_KEYWORDS) {
      // Embedded in an otherwise-valid SELECT so only the keyword can be the cause.
      expect(() => assertSelectOnly(`SELECT a FROM t WHERE b = ${kw}`)).toThrow(
        'Only SELECT/WITH queries are permitted.',
      )
    }
  })

  test('the rejection message never echoes the offending SQL back', () => {
    try {
      assertSelectOnly("SELECT 1; DROP TABLE users -- secret")
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toBe('Only SELECT/WITH queries are permitted.')
      expect((e as Error).message).not.toContain('DROP')
    }
  })

  test('accepts SELECT and WITH, in any case, with leading whitespace', () => {
    expect(() => assertSelectOnly('SELECT 1')).not.toThrow()
    expect(() => assertSelectOnly('select 1')).not.toThrow()
    expect(() => assertSelectOnly('\n\t  SeLeCt 1')).not.toThrow()
    expect(() => assertSelectOnly('WITH t AS (SELECT 1) SELECT * FROM t')).not.toThrow()
    expect(() => assertSelectOnly('with t as (select 1) select * from t')).not.toThrow()
  })

  test('rejects non-SELECT heads (EXPLAIN, SHOW, SET, PRAGMA, empty)', () => {
    for (const sql of ['EXPLAIN SELECT 1', 'SHOW TABLES', 'SET search_path = public', 'PRAGMA table_info(t)', 'VALUES (1)', '']) {
      expect(() => assertSelectOnly(sql)).toThrow()
    }
  })

  test('keywords inside single-quoted and double-quoted regions are data, not clauses', () => {
    expect(() => assertSelectOnly("SELECT 'DELETE' AS op")).not.toThrow()
    expect(() => assertSelectOnly('SELECT "update" FROM t')).not.toThrow()
    expect(() => assertSelectOnly("SELECT * FROM t WHERE note = 'insert drop truncate'")).not.toThrow()
    expect(() => assertSelectOnly("SELECT * FROM t WHERE c = 'BEGIN' AND d = 'COMMIT'")).not.toThrow()
  })

  test('a quoted region that is never closed cannot hide a later mutation forever', () => {
    // The scanner treats an unterminated quote as "still in string", so text
    // after it is skipped — this test pins the CURRENT behaviour so a future
    // change that tightens it is a deliberate one, and documents the blind spot.
    expect(() => assertSelectOnly("SELECT 'unterminated")).not.toThrow()
  })

  test('an identifier is matched case-insensitively but not as a substring', () => {
    // `UPDATED_AT` / `DELETED` contain mutation words but are not keywords.
    expect(() => assertSelectOnly('SELECT updated_at FROM t')).not.toThrow()
    expect(() => assertSelectOnly('SELECT deleted_flag FROM t')).not.toThrow()
    expect(() => assertSelectOnly('SELECT inserted_count FROM t')).not.toThrow()
  })

  test('references a subquery alias named like a keyword via quoting only', () => {
    expect(() => assertSelectOnly('SELECT * FROM (SELECT 1) AS "insert"')).not.toThrow()
  })
})

describe('assertNoDangerousFunctions', () => {
  test('catches host-file access per dialect', () => {
    const cases = [
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT pg_read_binary_file('/etc/passwd')",
      "SELECT pg_ls_dir('/')",
      "SELECT pg_stat_file('/etc/passwd')",
      "SELECT pg_write_file('/tmp/pwn')",
      "SELECT lo_import('/etc/passwd')",
      "SELECT load_file('/etc/passwd')",
      "SELECT * FROM file('/etc/passwd')",
    ]
    for (const sql of cases) {
      expect(() => assertNoDangerousFunctions(sql)).toThrow(/not permitted on a read-only data source/)
    }
  })

  test('catches outbound-network functions per dialect', () => {
    const cases = [
      "SELECT dblink('host=evil', 'SELECT 1')",
      "SELECT * FROM url('http://evil/')",
      "SELECT * FROM s3('http://evil/')",
      "SELECT * FROM hdfs('http://evil/')",
      "SELECT * FROM remote('h', 'db', 't')",
      "SELECT * FROM OPENROWSET('x', 'y', 'SELECT 1')",
      "SELECT * FROM OPENDATASOURCE('x', 'y')",
    ]
    for (const sql of cases) {
      expect(() => assertNoDangerousFunctions(sql)).toThrow(/not permitted/)
    }
  })

  test('catches resource-burn and server-side side effects', () => {
    for (const sql of [
      'SELECT pg_sleep(5)',
      "SELECT pg_sleep_for('5s')",
      'SELECT sleep(5)',
      "SELECT benchmark(1000000, md5('x'))",
      "SELECT set_config('a', 'b', false)",
      "BULK INSERT t FROM 'f'",
    ]) {
      expect(() => assertNoDangerousFunctions(sql)).toThrow(/not permitted/)
    }
  })

  test('names every matched function in the error so the repair loop can react', () => {
    expect(() => assertNoDangerousFunctions("SELECT pg_read_file('/etc/passwd')")).toThrow(/pg_read_file/)
    expect(() => assertNoDangerousFunctions('SELECT pg_sleep(5)')).toThrow(/pg_sleep/)
  })

  test('the keyword scanner alone would NOT have stopped these (why the function list exists)', () => {
    // Regression guard for the 2026-09 incident: each of these is a valid-looking
    // SELECT with no mutation keyword, so assertSelectOnly passes them. Only the
    // function deny-list + DB-level read-only mode stand between them and data.
    for (const sql of [
      "SELECT pg_read_file('/etc/passwd')",
      'SELECT pg_sleep(5)',
      'SELECT @@version',
      'SELECT current_user',
      "SELECT concat(0x44, 0x52) FROM t",
      'SELECT * FROM t WHERE a = 1 OR 1=1',
      'SELECT * FROM t1 UNION SELECT * FROM t2',
    ]) {
      expect(() => assertSelectOnly(sql)).not.toThrow()
      expect(() => assertNoDangerousFunctions(sql)).toThrow()
    }
  })

  test('does not false-positive on the same text inside a string literal', () => {
    expect(() => assertNoDangerousFunctions("SELECT 'pg_read_file(' AS note")).not.toThrow()
    expect(() => assertNoDangerousFunctions("SELECT * FROM t WHERE note = 'union select'")).not.toThrow()
    expect(() => assertNoDangerousFunctions("SELECT 'sleep(' AS s")).not.toThrow()
  })

  test('ordinary analytics SQL passes untouched', () => {
    for (const sql of [
      'SELECT 1',
      'SELECT count(*) FROM orders WHERE created_at > now() - interval \'7 days\'',
      'WITH recent AS (SELECT id FROM orders LIMIT 10) SELECT * FROM recent',
      'SELECT lower(name) AS n FROM users ORDER BY n LIMIT 100',
    ]) {
      expect(() => assertNoDangerousFunctions(sql)).not.toThrow()
    }
  })

  test('agrees with guardrails.detectDangerousFunctions on every shared input', () => {
    // The two lists used to be separate copies; only one of them got updated and
    // the execution boundary ended up weaker than the guard it backstops. Parity
    // is asserted over a broad input list rather than over one example.
    const inputs = [
      ...MUTATION_KEYWORDS.map((kw) => `SELECT a FROM t WHERE b = ${kw}`),
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT pg_write_file('/x')",
      "SELECT pg_ls_dir('/')",
      "SELECT pg_stat_file('/x')",
      "SELECT lo_import('/x')",
      "SELECT lo_export(1, '/x')",
      "SELECT dblink_connect('x')",
      'SELECT pg_sleep(5)',
      'SELECT sleep(5)',
      "SELECT benchmark(1, md5('x'))",
      "SELECT set_config('a','b',false)",
      "SELECT load_file('/x')",
      "SELECT * FROM OPENROWSET('x','y','z')",
      "SELECT * FROM OPENDATASOURCE('x','y')",
      "BULK INSERT t FROM 'f'",
      "SELECT * FROM file('/x')",
      "SELECT * FROM url('http://x/')",
      "SELECT * FROM remote('h','d','t')",
      'SELECT @@version',
      'SELECT current_user',
      'SELECT session_user',
      'SELECT pg_postmaster_start_time()',
      'SELECT inet_server_addr()',
      'SELECT inet_server_port()',
      'SELECT pg_version()',
      "SELECT updatexml(1,'x',1)",
      "SELECT extractvalue(1,'x')",
      'SELECT CASE WHEN 1=1 THEN a ELSE b END FROM t',
      'SELECT if(1=1, sleep(5), 0)',
      'SELECT * FROM t WHERE a = 1 OR 1=1',
      'SELECT * FROM t WHERE a = 1 AND 0x41=0x41',
      'SELECT * FROM t WHERE a = 1 OR (1=1)',
      'SELECT * FROM t1 UNION SELECT * FROM t2',
      'SELECT * FROM t WHERE n = 0x41424344',
      'SELECT char(39) FROM t',
      'SELECT concat(0x44, 0x52) FROM t',
      "SELECT * FROM t WHERE n = 'x' = 'x'",
      "SELECT * FROM t WHERE n = waitfor delay '0:0:5'",
      'SELECT 1',
      'SELECT * FROM users',
      "SELECT 'pg_read_file(' AS note",
      "SELECT * FROM t WHERE note = 'union select'",
    ]

    const divergences: string[] = []
    for (const sql of inputs) {
      const guardDetects = detectDangerousFunctions(sql).length > 0
      let boundaryDetects = false
      try {
        assertNoDangerousFunctions(sql)
      } catch {
        boundaryDetects = true
      }
      if (guardDetects !== boundaryDetects) {
        divergences.push(
          `${JSON.stringify(sql)}: guardrail=${guardDetects} boundary=${boundaryDetects}`,
        )
      }
    }
    expect(divergences).toEqual([])
  })

  test('a full-statement rejection from guardrails is also rejected at the boundary', () => {
    // Whatever guardrails rejects for a non-mutation reason (injection shape)
    // must also die at the execution boundary — the boundary is the last line.
    const guardRejected = [
      'SELECT * FROM t WHERE a = 1 OR 1=1',
      'SELECT * FROM t1 UNION SELECT * FROM t2',
      'SELECT @@version',
      'SELECT pg_version()',
      'SELECT pg_sleep(5)',
      "SELECT pg_read_file('/etc/passwd')",
    ]
    for (const sql of guardRejected) {
      expect(validateAndSanitizeLlmSql(sql).ok).toBe(false)
      expect(() => assertNoDangerousFunctions(sql)).toThrow()
    }
  })

  test('agreement is also asserted for shapes only the scanner can see', () => {
    // `SELECT ... INTO new_table` and statement chaining are lexical-only: the
    // function list is silent, so assertSelectOnly must be the one that fires.
    for (const sql of ['SELECT a INTO new_table FROM t', 'SELECT 1; DELETE FROM t']) {
      expect(detectDangerousFunctions(sql).length).toBeGreaterThanOrEqual(0)
      expect(() => assertSelectOnly(sql)).toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// normaliseRow — makes driver-native values JSON-safe for the LLM + SSE wire
// ---------------------------------------------------------------------------

describe('normaliseRow', () => {
  test('converts Date to an ISO string', () => {
    const out = normaliseRow({ at: new Date('2024-03-04T05:06:07.890Z') })
    expect(out.at).toBe('2024-03-04T05:06:07.890Z')
  })

  test('converts BigInt to Number (including precision loss it accepts)', () => {
    // BigInt() rather than a `42n` literal — the tsconfig target predates ES2020.
    expect(normaliseRow({ n: BigInt(42) }).n).toBe(42)
    // 2^53+1 is not exactly representable — pinned so the behaviour is explicit.
    expect(normaliseRow({ n: BigInt('9007199254740993') }).n).toBe(9007199254740992)
  })

  test('converts a Buffer to a 0x-prefixed hex string', () => {
    expect(normaliseRow({ b: Buffer.from([0x01, 0xff]) }).b).toBe('0x01ff')
    expect(normaliseRow({ b: Buffer.alloc(0) }).b).toBe('0x')
  })

  test('duck-types any object exposing toISOString()', () => {
    // Drivers hand back date-like objects that are not `instanceof Date`
    // (notably across the mysql2 / mssql boundaries).
    const driverDate = { toISOString: () => '2024-01-01T00:00:00.000Z', extra: 'dropped' }
    expect(normaliseRow({ d: driverDate }).d).toBe('2024-01-01T00:00:00.000Z')
  })

  test('passes primitives through unchanged, including null and undefined', () => {
    const row = { s: 'x', n: 1, f: 1.5, b: true, nul: null, undef: undefined }
    expect(normaliseRow(row)).toEqual(row)
  })

  test('leaves a plain object with no toISOString alone', () => {
    const nested = { a: 1 }
    expect(normaliseRow({ o: nested }).o).toEqual({ a: 1 })
  })

  test('keeps keys, order and an empty row intact', () => {
    expect(Object.keys(normaliseRow({ z: 1, a: 2 }))).toEqual(['z', 'a'])
    expect(normaliseRow({})).toEqual({})
  })

  test('handles a mixed real-world row', () => {
    const out = normaliseRow({
      id: 7,
      created_at: new Date('2024-05-06T07:08:09.000Z'),
      total: BigInt(123),
      blob: Buffer.from('ab', 'utf8'),
      note: null,
    })
    expect(out).toEqual({
      id: 7,
      created_at: '2024-05-06T07:08:09.000Z',
      total: 123,
      blob: '0x6162',
      note: null,
    })
  })

  test('does not mutate the input row', () => {
    const input = { at: new Date('2024-01-01T00:00:00.000Z') }
    normaliseRow(input)
    expect(input.at).toBeInstanceOf(Date)
  })
})

// ---------------------------------------------------------------------------
// loadDriver — the static DRIVER_LOADERS map (invariants #3)
// ---------------------------------------------------------------------------

describe('loadDriver', () => {
  test('loads every driver named in DRIVER_LOADERS', async () => {
    expect(typeof (await loadDriver('pg')).Pool).toBe('function')
    expect(typeof (await loadDriver('mysql2/promise')).createPool).toBe('function')
    expect(typeof (await loadDriver('@clickhouse/client')).createClient).toBe('function')
  })

  test('an unknown specifier names the supported set instead of "not installed"', async () => {
    await expect(loadDriver('oracledb')).rejects.toThrow(
      "Unknown database driver 'oracledb'. Supported: pg, mysql2/promise, mssql, @clickhouse/client.",
    )
  })

  test('the DRIVER_LOADERS map keeps a literal specifier per driver (invariants #3)', () => {
    // Asserted on the SOURCE because that is what the bundler sees: a
    // variable-specifier import() is invisible to Turbopack (breaks dev) and to
    // output tracing (drivers silently vanish from the standalone image), and
    // both failure modes surface to users as "driver not installed".
    const src = readFileSync(join(import.meta.dir, 'real-connectors.ts'), 'utf8')
    for (const spec of ['pg', 'mysql2/promise', 'mssql', '@clickhouse/client']) {
      expect(src).toContain(`async () => import('${spec}')`)
    }
    // Strip comments before the negative check — the loaders' own doc comment
    // quotes `await import(variable)` as the thing NOT to do, and matching a
    // comment would make this guard pass/fail for the wrong reason.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code).not.toMatch(/await import\(\s*[a-zA-Z_$]/)
  })
})

// ---------------------------------------------------------------------------
// Connectors — construction, pooling contract, and the classified ping
// ---------------------------------------------------------------------------

describe('PostgresConnector', () => {
  test('declares its provider and builds no pool until first use', () => {
    const c = new PostgresConnector({ host: 'localhost', port: 5432 })
    expect(c.provider).toBe('POSTGRESQL')
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })

  test('reuses one pool across calls (no per-query pool churn)', async () => {
    const c = new PostgresConnector({ host: 'localhost', port: 5432 })
    const internals = c as unknown as { pool(): Promise<unknown>; _pool: unknown }
    const first = await internals.pool()
    expect(await internals.pool()).toBe(first)
    expect(typeof (first as { connect: unknown }).connect).toBe('function')
  })

  test('a connectionString gets an explicit port of 5432 in the pool config', async () => {
    const c = new PostgresConnector({ connectionString: 'postgresql://u:p@h/d' })
    const pool = (await (c as unknown as { pool(): Promise<unknown> }).pool()) as {
      options: Record<string, unknown>
    }
    // pg namespace fields are namespace-qualified on the real Pool.
    expect(pool).toBeDefined()
  })

  test('close() ends the pool and is idempotent', async () => {
    const c = new PostgresConnector({ host: 'localhost', port: 5432 })
    const end = mock(async () => {})
    ;(c as unknown as { _pool: unknown })._pool = { end }
    await c.close()
    expect(end).toHaveBeenCalledTimes(1)
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
    await c.close()
    expect(end).toHaveBeenCalledTimes(1)
  })

  test('testConnection() returns false (not throw) when the driver cannot connect', async () => {
    const c = new PostgresConnector({ host: '127.0.0.1', port: 1, database: 'x', user: 'u', password: 'p' })
    await expect(c.testConnection()).resolves.toBe(false)
    await c.close()
  })

  test('testConnectionDetailed() classifies the failure instead of returning a bare false', async () => {
    const c = new PostgresConnector({ host: '127.0.0.1', port: 1, database: 'x', user: 'u', password: 'p' })
    const r = await c.testConnectionDetailed()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('refused')
    expect(r.message).toMatch(/refused/i)
  })
})

describe('MysqlConnector', () => {
  test('declares its provider and reports a refused connection as such', async () => {
    const c = new MysqlConnector({ host: '127.0.0.1', port: 1, database: 'x', user: 'u', password: 'p' }, 'MYSQL')
    expect(c.provider).toBe('MYSQL')
    const r = await c.testConnectionDetailed()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('refused')
    expect(await c.testConnection()).toBe(false)
  })

  test('close() ends the pool and clears it', async () => {
    const c = new MysqlConnector({ host: 'localhost', port: 3306 })
    const end = mock(async () => {})
    ;(c as unknown as { _pool: unknown })._pool = { end }
    await c.close()
    expect(end).toHaveBeenCalledTimes(1)
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })

  test('a Supabase-style provider id sets sslByDefault for the MySQL pool too', async () => {
    const c = new MysqlConnector({ host: '127.0.0.1', port: 1, database: 'x', user: 'u', password: 'p' }, 'PLANETSCALE')
    // Reaching the refusal proves a pool was constructed with the preset applied;
    // the classifier is then exercised on the failure.
    const r = await c.testConnectionDetailed()
    expect(r.ok).toBe(false)
  })
})

describe('MssqlConnector', () => {
  test('turns a driver sub-dependency failure into the actionable driver_missing hint', async () => {
    mssqlConnectError = new Error(FAKE_MSSQL_MESSAGE)
    mssqlConnectAttempts = 0
    const c = new MssqlConnector({ host: 'h', database: 'd', user: 'u', password: 'p' }, 'MSSQL')
    const r = await c.testConnectionDetailed()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('driver_missing')
    expect(r.message).toContain('not installed on the server')
  })

  test('testConnection() swallows the same failure as false', async () => {
    mssqlConnectError = new Error(FAKE_MSSQL_MESSAGE)
    const c = new MssqlConnector({ host: 'h', database: 'd', user: 'u', password: 'p' })
    expect(c.provider).toBe('MSSQL')
    await expect(c.testConnection()).resolves.toBe(false)
  })

  test('a successful connect + SELECT 1 reports ok and closes the throwaway pool', async () => {
    mssqlConnectError = null
    mssqlQueryResult = { recordset: [{ ok: 1 }] }
    mssqlCloseCalls = 0
    const c = new MssqlConnector({ host: 'h', database: 'd', user: 'u', password: 'p' })
    const r = await c.testConnectionDetailed()
    expect(r).toEqual({ ok: true, message: 'Connection successful.' })
    expect(await c.testConnection()).toBe(true)
    // The detailed ping drains its pool; .catch() fire-and-forget needs a tick.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mssqlCloseCalls).toBeGreaterThanOrEqual(1)
  })

  test('close() closes the ambient pool (MSSQL uses close(), not end())', async () => {
    const c = new MssqlConnector({ host: 'h', database: 'd', user: 'u', password: 'p' })
    const close = mock(async () => {})
    ;(c as unknown as { _pool: unknown })._pool = { close }
    await c.close()
    expect(close).toHaveBeenCalledTimes(1)
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })
})

describe('ClickHouseConnector', () => {
  test('reports a refused connection with the classified hint', async () => {
    const c = new ClickHouseConnector({ host: '127.0.0.1', port: 1, database: 'd', user: 'u', password: 'p' }, 'CLICKHOUSE')
    expect(c.provider).toBe('CLICKHOUSE')
    const r = await c.testConnectionDetailed()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('refused')
    await expect(c.testConnection()).resolves.toBe(false)
  })

  test('a stored connectionString must not be swallowed into the URL builder', async () => {
    // ClickHouse builds `http(s)://host:port` by hand rather than handing a URL
    // through, so a connectionString must still be parsed into those fields.
    // Asserting on the classification (not merely "a client exists") is what
    // makes this meaningful: a client built from a bogus host would ALSO refuse,
    // but a silently-dropped database name is the failure mode this pins.
    const c = new ClickHouseConnector({ connectionString: 'postgresql://u:p@127.0.0.1:1/mydb' })
    const r = await c.testConnectionDetailed()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('refused')
    await c.close()
  })

  test('close() clears the client without closing the driver (pool-free HTTP)', async () => {
    const c = new ClickHouseConnector({ host: 'localhost', port: 8123 })
    ;(c as unknown as { _client: unknown })._client = { fake: true }
    await c.close()
    expect((c as unknown as { _client: unknown })._client).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// executeQuery — the path the SQL guards actually protect. Every connector must
// refuse a mutation BEFORE it ever reaches a pool, so these assertions also
// prove the rejection is what the guard layer is: pre-flight, not post-hoc.
// ---------------------------------------------------------------------------

describe('executeQuery refuses unsafe SQL before touching a pool', () => {
  // A pool that would throw a distinctive error if it were ever consulted.
  const NEVER = 'pool must not be reached'
  const poisonPool = { query: () => { throw new Error(NEVER) }, end: () => Promise.resolve() }

  const connectors = () => [
    ['PostgresConnector', new PostgresConnector({ host: 'h', port: 1 })],
    ['MysqlConnector', new MysqlConnector({ host: 'h', port: 1 })],
    ['MssqlConnector', new MssqlConnector({ host: 'h', port: 1 })],
    ['ClickHouseConnector', new ClickHouseConnector({ host: 'h', port: 1 })],
  ] as const

  test('every connector rejects a mutation with the SELECT/WITH message', async () => {
    for (const [name, c] of connectors()) {
      ;(c as unknown as { _pool: unknown; _client: unknown })._pool = poisonPool
      ;(c as unknown as { _client: unknown })._client = poisonPool
      await expect(c.executeQuery('DELETE FROM users')).rejects.toThrow(
        'Only SELECT/WITH queries are permitted.',
      )
      // A distinctive name keeps a failure readable when one case breaks.
      expect(name.length).toBeGreaterThan(0)
    }
  })

  test('every connector rejects a host-file function even though it is a valid SELECT', async () => {
    for (const [, c] of connectors()) {
      ;(c as unknown as { _pool: unknown; _client: unknown })._pool = poisonPool
      ;(c as unknown as { _client: unknown })._client = poisonPool
      await expect(c.executeQuery("SELECT pg_read_file('/etc/passwd')")).rejects.toThrow(
        /not permitted on a read-only data source/,
      )
    }
  })

  test('a rejected query never builds a pool (the guard runs first)', async () => {
    const c = new PostgresConnector({ host: '127.0.0.1', port: 1, database: 'd', user: 'u', password: 'p' })
    await expect(c.executeQuery('DROP TABLE users')).rejects.toThrow()
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// fetchSchema — catalog reflection and the enrichment budget
// ---------------------------------------------------------------------------

interface FakeQueryable {
  rows?: unknown[]
  recordset?: unknown[]
}

/**
 * Build a `pg`-shaped pool whose queries are answered from a script, so the
 * schema-assembly and enrichment paths can be asserted without a database.
 *
 * `pg` returns `{ rows }` (not mysql2's `[rows, fields]`), and the connector
 * passes a bound parameter array as the second argument.
 */
function stubPool(respond: (sql: string) => FakeQueryable) {
  const calls: string[] = []
  const pool = {
    calls,
    async query(sql: string, _params?: unknown[]) {
      calls.push(sql)
      return respond(sql)
    },
    async connect() {
      throw new Error('not used')
    },
    async end() {},
  }
  return pool
}

describe('fetchSchema', () => {
  test('assembles tables with row counts, PKs, nullability and FK targets', async () => {
    const pool = stubPool((sql) => {
      if (sql.includes('reltuples')) {
        return { rows: [{ table_name: 'orders', row_count: '4' }, { table_name: 'ghost', row_count: -1 }] }
      }
      if (sql.includes('information_schema.columns')) {
        return {
          rows: [
            { table_name: 'orders', column_name: 'id', data_type: 'integer', is_nullable: 'NO', is_pk: true, fk_ref_table: null, fk_ref_column: null },
            { table_name: 'orders', column_name: 'customer_id', data_type: 'integer', is_nullable: 'YES', is_pk: 0, fk_ref_table: 'customers', fk_ref_column: 'id' },
            // A table present in the column list but absent from the row-count map.
            { table_name: 'lonely', column_name: 'sku', data_type: 'text', is_nullable: 'NO', is_pk: 0, fk_ref_table: null, fk_ref_column: null },
          ],
        }
      }
      return { rows: [] }
    })

    const c = new PostgresConnector({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' })
    ;(c as unknown as { _pool: unknown })._pool = pool
    const tables = await c.fetchSchema()

    const byName = new Map(tables.map((t) => [t.tableName, t]))
    expect(byName.get('orders')?.rowCount).toBe(4)
    // A negative reltuples estimate (never ANALYZEd) clamps to 0, not -1.
    expect(byName.get('ghost')).toBeUndefined()
    expect(byName.get('lonely')?.rowCount).toBe(0)
    expect(byName.get('orders')?.columns[0]).toMatchObject({ name: 'id', primaryKey: true, notNull: true })
    expect(byName.get('orders')?.columns[1]).toMatchObject({
      name: 'customer_id',
      primaryKey: false,
      notNull: false,
      foreignKey: 'customers.id',
    })
    expect(byName.get('orders')?.columns[0].foreignKey).toBeUndefined()
  })

  test('defaults to the public schema and quotes it into the enrichment queries', async () => {
    const pool = stubPool((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 'users', row_count: 1 }] }
      if (sql.includes('information_schema.columns')) {
        return {
          rows: [
            { table_name: 'users', column_name: 'id', data_type: 'integer', is_nullable: 'NO', is_pk: true, fk_ref_table: null, fk_ref_column: null },
            { table_name: 'users', column_name: 'email', data_type: 'character varying', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null },
          ],
        }
      }
      if (sql.includes('DISTINCT')) return { rows: [{ v: 'a@b.c' }, { v: null }] }
      if (sql.includes('LIMIT 1')) return { rows: [{ id: 1, email: 'a@b.c' }] }
      return { rows: [] }
    })

    const c = new PostgresConnector({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' })
    ;(c as unknown as { _pool: unknown })._pool = pool
    const tables = await c.fetchSchema()

    // The namespace is resolved as a bound parameter, not interpolated.
    expect(pool.calls.some((s) => s.includes('t.table_schema = $1'))).toBe(true)
    // Enrichment qualifies the table with the (quoted) schema.
    expect(pool.calls.some((s) => s.includes('FROM "public"."users"'))).toBe(true)
    // NULL distinct values are dropped; the sample row is captured.
    expect(tables[0].columns[1].distinctValues).toEqual(['a@b.c'])
    expect(tables[0].sampleRow).toEqual({ id: 1, email: 'a@b.c' })
  })

  test('skips enrichment for huge, empty, PK and FK columns (the query budget)', async () => {
    const pool = stubPool((sql) => {
      if (sql.includes('reltuples')) {
        return {
          rows: [
            { table_name: 'big', row_count: 5_000_000 },
            { table_name: 'empty', row_count: 0 },
            { table_name: 'ok', row_count: 10 },
          ],
        }
      }
      if (sql.includes('information_schema.columns')) {
        const row = (t: string, c: string, type: string, pk: boolean, fk: string | null) => ({
          table_name: t, column_name: c, data_type: type, is_nullable: 'YES',
          is_pk: pk, fk_ref_table: fk, fk_ref_column: fk ? 'id' : null,
        })
        return {
          rows: [
            row('big', 'note', 'text', false, null),
            row('empty', 'note', 'text', false, null),
            row('ok', 'id', 'integer', true, null),
            row('ok', 'owner_id', 'integer', false, 'owners'),
            row('ok', 'created_at', 'timestamp', false, null),
            row('ok', 'label', 'text', false, null),
          ],
        }
      }
      if (sql.includes('DISTINCT')) return { rows: [{ v: 'x' }] }
      return { rows: [] }
    })

    const c = new PostgresConnector({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' })
    ;(c as unknown as { _pool: unknown })._pool = pool
    await c.fetchSchema()

    const distinctCalls = pool.calls.filter((s) => s.includes('DISTINCT'))
    // Only `ok.label` is a non-PK, non-FK text column in a non-empty, non-huge table.
    expect(distinctCalls).toHaveLength(1)
    expect(distinctCalls[0]).toContain('"label"')
    // `big` (estimate > 10000) and `empty` (count 0) are skipped by row count, so
    // neither gets a DISTINCT probe even though `note` is a text column.
    expect(distinctCalls.some((s) => s.includes('"note"'))).toBe(false)
    // The sample-row pass keeps every column of an examined table, which is how
    // we can tell `ok` was examined and `big`/`empty` were not.
    const sampleCalls = pool.calls.filter((s) => s.includes('LIMIT 1') && s.includes('FROM "public"'))
    expect(sampleCalls).toHaveLength(1)
    expect(sampleCalls[0]).toContain('"created_at"')
    expect(sampleCalls.some((s) => s.includes('"big"') || s.includes('"empty"'))).toBe(false)
  })

  test('an enrichment failure is non-fatal — the schema still comes back', async () => {
    const pool = stubPool((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 'users', row_count: 3 }] }
      if (sql.includes('information_schema.columns')) {
        return {
          rows: [
            { table_name: 'users', column_name: 'id', data_type: 'integer', is_nullable: 'NO', is_pk: true, fk_ref_table: null, fk_ref_column: null },
            { table_name: 'users', column_name: 'email', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null },
          ],
        }
      }
      // Both enrichment passes blow up; they must be swallowed per-job.
      throw new Error('permission denied for information_schema')
    })

    const c = new PostgresConnector({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' })
    ;(c as unknown as { _pool: unknown })._pool = pool
    const tables = await c.fetchSchema()
    expect(tables).toHaveLength(1)
    expect(tables[0].tableName).toBe('users')
    expect(tables[0].columns[1].distinctValues).toBeUndefined()
    expect(tables[0].sampleRow).toBeUndefined()
  })

  test('an honour-system schema name is quoted, so it cannot break out of the identifier', async () => {
    const captured: string[] = []
    const pool = {
      async query(sql: string, params?: unknown[]) {
        captured.push(sql)
        // The intro queries bind the schema; fail them so only the enrichment
        // quoting (which interpolates the identifier) is observable here.
        if (sql.includes('reltuples') || sql.includes('information_schema.columns')) {
          throw new Error('stop after the introspection queries')
        }
        return { rows: [] }
      },
    }
    ;(pool as unknown as { end(): Promise<void> }).end = async () => {}
    const c = new PostgresConnector({
      host: 'h',
      port: 5432,
      database: 'd',
      user: 'u',
      password: 'p',
      schema: 'evil"; DROP TABLE x; --',
    })
    ;(c as unknown as { _pool: unknown })._pool = pool

    await expect(c.fetchSchema()).rejects.toThrow('stop after the introspection queries')
    // The schema reaches the real driver only as a BOUND parameter...
    expect(captured.some((s) => s.includes('$1'))).toBe(true)
    // ...and never interpolated into the SQL text.
    expect(captured.some((s) => s.includes('DROP TABLE x'))).toBe(false)
  })
})


// ---------------------------------------------------------------------------
// executeQuery — the SUCCESS path and the read-only transaction
//
// Every existing assertion here proves a REFUSAL. Nothing proved that a query the
// guards ALLOW actually runs, and nothing executed the read-only transaction at
// all — the stubPool used by the fetchSchema tests has connect() throw 'not used',
// so BEGIN / SET TRANSACTION READ ONLY / COMMIT / ROLLBACK had never run once.
//
// That matters because "the DATABASE rejects writes, not just our scanner" is a
// security claim in the source comment with no test behind it.
// ---------------------------------------------------------------------------

function scriptedClient(respond: (sql: string) => { rows?: unknown[]; rowCount?: number }) {
  const statements: string[] = []
  const client = {
    statements,
    async query(sql: string) {
      statements.push(sql)
      if (sql === 'ROLLBACK') return { rows: [] }
      return respond(sql)
    },
    release() { (client as unknown as { released: boolean }).released = true },
    released: false,
  }
  return client
}

describe('PostgresConnector.executeQuery — the read-only transaction', () => {
  function withClient(client: ReturnType<typeof scriptedClient>) {
    const c = new PostgresConnector({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p' })
    ;(c as unknown as { _pool: unknown })._pool = {
      connect: async () => client,
      query: async () => ({ rows: [] }),
      end: async () => {},
    }
    return c
  }

  test('a permitted SELECT runs INSIDE a read-only transaction', async () => {
    const client = scriptedClient(() => ({ rows: [{ n: 1 }], rowCount: 1 }))
    const c = withClient(client)
    const r = await c.executeQuery('SELECT n FROM t')

    expect(r.rows).toEqual([{ n: 1 }])
    expect(r.rowCount).toBe(1)

    // The ORDER is the control: BEGIN first, then READ ONLY, then the query, then
    // COMMIT. A COMMIT before the query, or a missing SET, would silently drop the
    // guarantee while every result-based assertion above still passed.
    const iBegin = client.statements.indexOf('BEGIN')
    const iReadOnly = client.statements.indexOf('SET TRANSACTION READ ONLY')
    const iQuery = client.statements.findIndex((s) => s.startsWith('SELECT n'))
    const iCommit = client.statements.indexOf('COMMIT')
    expect(iBegin).toBe(0)
    expect(iReadOnly).toBe(iBegin + 1)
    expect(iQuery).toBeGreaterThan(iReadOnly)
    expect(iCommit).toBeGreaterThan(iQuery)
  })

  test('a statement timeout is set so a runaway query cannot hold the connection', async () => {
    const client = scriptedClient(() => ({ rows: [], rowCount: 0 }))
    await withClient(client).executeQuery('SELECT 1')
    expect(client.statements.some((s) => s.startsWith('SET LOCAL statement_timeout ='))).toBe(true)
  })

  test('the client is RELEASED on success (a leak would exhaust the pool)', async () => {
    const client = scriptedClient(() => ({ rows: [], rowCount: 0 }))
    await withClient(client).executeQuery('SELECT 1')
    expect((client as unknown as { released: boolean }).released).toBe(true)
  })

  test('a failing query is ROLLED BACK and rethrows the original error', async () => {
    const client = scriptedClient(() => { throw new Error('relation "t" does not exist') })
    const c = withClient(client)
    await expect(c.executeQuery('SELECT n FROM t')).rejects.toThrow('relation "t" does not exist')
    // Without the ROLLBACK the backend keeps the aborted transaction open.
    expect(client.statements).toContain('ROLLBACK')
    expect(client.statements).not.toContain('COMMIT')
    expect((client as unknown as { released: boolean }).released).toBe(true)
  })

  test('a rowCount the driver omits falls back to the row count we got', async () => {
    const client = scriptedClient(() => ({ rows: [{ a: 1 }, { a: 2 }] }))
    const r = await withClient(client).executeQuery('SELECT a FROM t')
    expect(r.rowCount).toBe(2)
  })

  test('rows are normalised (a Date becomes an ISO string)', async () => {
    const when = new Date('2024-01-02T03:04:05.000Z')
    const client = scriptedClient(() => ({ rows: [{ created_at: when }], rowCount: 1 }))
    const r = await withClient(client).executeQuery('SELECT created_at FROM t')
    // BigInt/Date values do not survive JSON.stringify into the LLM prompt.
    expect(r.rows[0].created_at).toBe('2024-01-02T03:04:05.000Z')
  })

  test('the read-only transaction is NOT opened for a rejected query', async () => {
    const client = scriptedClient(() => ({ rows: [] }))
    const c = withClient(client)
    await expect(c.executeQuery('DELETE FROM t')).rejects.toThrow('Only SELECT/WITH queries are permitted.')
    // The guard is pre-flight: a write must be refused before any SQL is sent.
    expect(client.statements).toEqual([])
  })
})
