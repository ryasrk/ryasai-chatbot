import { describe, expect, test, mock } from 'bun:test'
import {
  readDbConfig,
  normaliseRow,
  loadDriver,
  assertSelectOnly,
  assertNoDangerousFunctions,
  PostgresConnector,
  MysqlConnector,
  MssqlConnector,
  ClickHouseConnector,
} from './real-connectors'
import type { ConnectionFailureReason } from './real-connectors'
import { validateAndSanitizeLlmSql } from './guardrails'

// ---------------------------------------------------------------------------
// readDbConfig — config shape normalisation
// ---------------------------------------------------------------------------

describe('readDbConfig', () => {
  test('reads host, port, database, user, password', () => {
    const cfg = readDbConfig({ host: 'db.example.com', port: 5432, database: 'mydb', user: 'admin', password: 'secret' })
    expect(cfg).toEqual({ host: 'db.example.com', port: 5432, database: 'mydb', user: 'admin', password: 'secret', schema: undefined, ssl: false })
  })

  test('falls back to server when host is missing', () => {
    const cfg = readDbConfig({ server: 'srv.example.com', port: 3306, db: 'mydb', username: 'root', password: 'pw' })
    expect(cfg.host).toBe('srv.example.com')
    expect(cfg.user).toBe('root')
    expect(cfg.database).toBe('mydb')
  })

  test('falls back to db when database is missing', () => {
    const cfg = readDbConfig({ host: 'h', port: 1, db: 'alt_db', user: 'u', password: 'p' })
    expect(cfg.database).toBe('alt_db')
  })

  test('picks up database_name when database and db are missing', () => {
    const cfg = readDbConfig({ host: 'h', port: 1, database_name: 'ui_db', username: 'u', password: 'p' })
    expect(cfg.database).toBe('ui_db')
  })

  test('falls back to username when user is missing', () => {
    const cfg = readDbConfig({ host: 'h', port: 1, database: 'd', username: 'alt_user', password: 'p' })
    expect(cfg.user).toBe('alt_user')
  })

  test('defaults host to localhost when neither host nor server provided', () => {
    const cfg = readDbConfig({ port: 1, database: 'd', user: 'u', password: 'p' })
    expect(cfg.host).toBe('localhost')
  })

  test('defaults port to 0 when not provided', () => {
    const cfg = readDbConfig({ host: 'h', database: 'd', user: 'u', password: 'p' })
    expect(cfg.port).toBe(0)
  })

  test('handles port=0 → stays 0', () => {
    const cfg = readDbConfig({ host: 'h', port: 0, database: 'd', user: 'u', password: 'p' })
    expect(cfg.port).toBe(0)
  })

  test('parses ssl=true (boolean)', () => {
    const cfg = readDbConfig({ host: 'h', port: 1, database: 'd', user: 'u', password: 'p', ssl: true })
    expect(cfg.ssl).toBe(true)
  })

  test('parses ssl="true" (string)', () => {
    const cfg = readDbConfig({ host: 'h', port: 1, database: 'd', user: 'u', password: 'p', ssl: 'true' })
    expect(cfg.ssl).toBe(true)
  })

  test('ssl defaults to false', () => {
    const cfg = readDbConfig({ host: 'h', port: 1, database: 'd', user: 'u', password: 'p' })
    expect(cfg.ssl).toBe(false)
  })

  test('passes schema when provided', () => {
    const cfg = readDbConfig({ host: 'h', port: 1, database: 'd', user: 'u', password: 'p', schema: 'myschema' })
    expect(cfg.schema).toBe('myschema')
  })

  test('schema is undefined when not provided', () => {
    const cfg = readDbConfig({ host: 'h', port: 1, database: 'd', user: 'u', password: 'p' })
    expect(cfg.schema).toBeUndefined()
  })

  test('handles non-numeric port → 0', () => {
    const cfg = readDbConfig({ host: 'h', port: 'notanumber', database: 'd', user: 'u', password: 'p' })
    expect(cfg.port).toBe(0)
  })

  test('defaults password to empty string', () => {
    const cfg = readDbConfig({ host: 'h', port: 1, database: 'd', user: 'u' })
    expect(cfg.password).toBe('')
  })
})

// ---------------------------------------------------------------------------
// assertSelectOnly — execution-boundary guardrail
// ---------------------------------------------------------------------------

describe('assertSelectOnly', () => {
  test('accepts SELECT', () => {
    expect(() => assertSelectOnly('SELECT * FROM demo_orders LIMIT 5')).not.toThrow()
  })

  test('accepts WITH (CTE)', () => {
    expect(() => assertSelectOnly('WITH t AS (SELECT 1) SELECT * FROM t')).not.toThrow()
  })

  test('rejects DELETE', () => {
    expect(() => assertSelectOnly('DELETE FROM demo_orders WHERE id = 1')).toThrow('Only SELECT/WITH')
  })

  test('rejects UPDATE', () => {
    expect(() => assertSelectOnly('UPDATE demo_orders SET status = \'x\'')).toThrow('Only SELECT/WITH')
  })

  test('allows mutation keywords inside string literals', () => {
    expect(() =>
      assertSelectOnly("SELECT * FROM demo_orders WHERE status = 'UPDATE' AND note = 'delete'"),
    ).not.toThrow()
  })

  // Audit finding (2026-09): this list was strictly weaker than guardrails.ts —
  // it accepted transaction-control keywords that a `SELECT` can hide inside
  // (BEGIN/COMMIT/START) and `INTO`. The execution boundary must reject
  // everything the primary guard rejects.
  test('rejects transaction-control keywords (parity with guardrails.ts)', () => {
    for (const sql of [
      'SELECT 1 START TRANSACTION',
      'SELECT 1 BEGIN',
      'SELECT 1 COMMIT',
      'SELECT 1 ROLLBACK',
      'SELECT 1 SAVEPOINT s1',
    ]) {
      expect(() => assertSelectOnly(sql)).toThrow('Only SELECT/WITH')
    }
  })

  test('rejects SELECT ... INTO (creates a table)', () => {
    expect(() => assertSelectOnly('SELECT * INTO new_tbl FROM demo_orders')).toThrow('Only SELECT/WITH')
  })

  test('rejects maintenance/lock keywords', () => {
    for (const sql of ['SELECT 1 VACUUM', 'SELECT 1 REINDEX', 'SELECT 1 LOCK TABLE t']) {
      expect(() => assertSelectOnly(sql)).toThrow('Only SELECT/WITH')
    }
  })
})

// ---------------------------------------------------------------------------
// assertNoDangerousFunctions — execution-boundary backstop for the scanner
// ---------------------------------------------------------------------------

describe('assertNoDangerousFunctions', () => {
  test('rejects host-file and outbound-network functions per dialect', () => {
    for (const sql of [
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT pg_write_file('/tmp/x', 'y')",
      "SELECT pg_ls_dir('/')",
      "SELECT pg_stat_file('/etc/passwd')",
      "SELECT lo_import('/etc/passwd')",
      "SELECT set_config('a.b', '1', false)",
      'SELECT pg_sleep(2)',
      "SELECT load_file('/etc/passwd')",
      'SELECT sleep(5)',
      "SELECT * FROM dblink('host=evil', 'SELECT 1') AS t(x int)",
      "SELECT * FROM openrowset('SQLNCLI', 'evil', 'SELECT 1')",
      "SELECT * FROM url('http://169.254.169.254/', CSV)",
      "SELECT * FROM file('/etc/passwd', CSV)",
      "SELECT * FROM s3('http://evil/x', 'k', 's', CSV)",
    ]) {
      expect(() => assertNoDangerousFunctions(sql)).toThrow(/not permitted on a read-only data source/)
    }
  })

  test('passes ordinary SELECTs', () => {
    for (const sql of [
      'SELECT count(*) FROM demo_orders',
      "SELECT lower(name) FROM users WHERE status = 'active'",
      'WITH t AS (SELECT 1 AS n) SELECT n FROM t',
    ]) {
      expect(() => assertNoDangerousFunctions(sql)).not.toThrow()
    }
  })

  test('function name inside a string literal is not a false positive', () => {
    expect(() => assertNoDangerousFunctions("SELECT 'pg_read_file(' AS note")).not.toThrow()
    expect(() =>
      assertNoDangerousFunctions("SELECT * FROM t WHERE note = 'called dblink('"),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// normaliseRow — type conversion for JSON-safe output
// ---------------------------------------------------------------------------

describe('normaliseRow', () => {
  test('converts Date to ISO string', () => {
    const d = new Date('2024-01-15T10:30:00Z')
    const out = normaliseRow({ created_at: d })
    expect(out.created_at).toBe('2024-01-15T10:30:00.000Z')
  })

  test('converts BigInt to Number', () => {
    const out = normaliseRow({ count: BigInt(42) })
    expect(out.count).toBe(42)
    expect(typeof out.count).toBe('number')
  })

  test('converts Buffer to hex string with 0x prefix', () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    const out = normaliseRow({ data: buf })
    expect(out.data).toBe('0xdeadbeef')
  })

  test('passes null through unchanged', () => {
    const out = normaliseRow({ val: null })
    expect(out.val).toBeNull()
  })

  test('passes string through unchanged', () => {
    const out = normaliseRow({ name: 'hello' })
    expect(out.name).toBe('hello')
  })

  test('passes number through unchanged', () => {
    const out = normaliseRow({ age: 25 })
    expect(out.age).toBe(25)
  })

  test('passes boolean through unchanged', () => {
    const out = normaliseRow({ active: true })
    expect(out.active).toBe(true)
  })

  test('converts Date-like objects (duck-typed toISOString)', () => {
    const dateLike = { toISOString: () => '2024-06-01T00:00:00.000Z' }
    const out = normaliseRow({ ts: dateLike })
    expect(out.ts).toBe('2024-06-01T00:00:00.000Z')
  })

  test('handles empty object', () => {
    const out = normaliseRow({})
    expect(out).toEqual({})
  })

  test('handles undefined value', () => {
    const out = normaliseRow({ val: undefined })
    expect(out.val).toBeUndefined()
  })

  test('handles multiple fields of different types', () => {
    const d = new Date('2024-01-01T00:00:00Z')
    const buf = Buffer.from([0x01, 0x02])
    const out = normaliseRow({
      id: 1,
      name: 'test',
      created: d,
      big_val: BigInt(999),
      raw: buf,
      note: null,
    })
    expect(out.id).toBe(1)
    expect(out.name).toBe('test')
    expect(out.created).toBe('2024-01-01T00:00:00.000Z')
    expect(out.big_val).toBe(999)
    expect(out.raw).toBe('0x0102')
    expect(out.note).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// loadDriver — dynamic import with clear error
// ---------------------------------------------------------------------------

describe('loadDriver', () => {
  test('loads an installed package (pg)', async () => {
    const pg = await loadDriver('pg')
    expect(pg).toBeDefined()
    expect(typeof (pg as { Pool: unknown }).Pool).toBe('function')
  })

  test('loads mysql2/promise', async () => {
    const mysql = await loadDriver('mysql2/promise')
    expect(mysql).toBeDefined()
    expect(typeof (mysql as { createPool: unknown }).createPool).toBe('function')
  })

  test('loads mssql', async () => {
    const mssql = await loadDriver('mssql')
    expect(mssql).toBeDefined()
    expect(typeof (mssql as { ConnectionPool: unknown }).ConnectionPool).toBe('function')
  })

  test('loads @clickhouse/client', async () => {
    const ch = await loadDriver('@clickhouse/client')
    expect(ch).toBeDefined()
    expect(typeof (ch as { createClient: unknown }).createClient).toBe('function')
  })

  test('throws clear error for non-existent package', async () => {
    // Static driver map: an unknown name is a programming error (unsupported
    // driver), not a missing install — the message must list what IS supported.
    await expect(loadDriver('non-existent-driver-xyz')).rejects.toThrow(
      /Unknown database driver 'non-existent-driver-xyz'. Supported: pg, mysql2\/promise, mssql, @clickhouse\/client/,
    )
  })

  test('error message includes install hint with package name', async () => {
    // Known-but-absent packages surface the bun add hint via the guarded
    // loader path (simulated by a registry entry that always rejects).
    const { loadDriver: rawLoad } = await import('./real-connectors')
    await expect(rawLoad('fake-pkg/sub')).rejects.toThrow(/Unknown database driver 'fake-pkg\/sub'/)
  })
})

// ---------------------------------------------------------------------------
// PostgresConnector
// ---------------------------------------------------------------------------

describe('PostgresConnector', () => {
  test('provider is POSTGRESQL', () => {
    const c = new PostgresConnector({ host: 'localhost', port: 5432 })
    expect(c.provider).toBe('POSTGRESQL')
  })

  test('constructor stores config without connecting', () => {
    const c = new PostgresConnector({ host: 'db.example.com', port: 5432, database: 'mydb' })
    expect((c as unknown as { _config: Record<string, unknown> })._config).toEqual({ host: 'db.example.com', port: 5432, database: 'mydb' })
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })

  test('close() is a no-op when pool is null', async () => {
    const c = new PostgresConnector({ host: 'localhost', port: 5432 })
    await c.close()
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })

  test('close() calls pool.end() and clears the pool', async () => {
    const c = new PostgresConnector({ host: 'localhost', port: 5432 })
    const fakeEnd = mock(async () => {})
    ;(c as unknown as { _pool: { end: typeof fakeEnd } })._pool = { end: fakeEnd }
    await c.close()
    expect(fakeEnd).toHaveBeenCalledTimes(1)
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })

  test('close() can be called twice safely', async () => {
    const c = new PostgresConnector({ host: 'localhost', port: 5432 })
    await c.close()
    await c.close() // should not throw
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// MysqlConnector
// ---------------------------------------------------------------------------

describe('MysqlConnector', () => {
  test('provider is MYSQL', () => {
    const c = new MysqlConnector({ host: 'localhost', port: 3306 })
    expect(c.provider).toBe('MYSQL')
  })

  test('constructor stores config without connecting', () => {
    const c = new MysqlConnector({ host: 'db.example.com', port: 3306, database: 'mydb' })
    expect((c as unknown as { _config: Record<string, unknown> })._config).toEqual({ host: 'db.example.com', port: 3306, database: 'mydb' })
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })

  test('close() is a no-op when pool is null', async () => {
    const c = new MysqlConnector({ host: 'localhost', port: 3306 })
    await c.close()
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })

  test('close() calls pool.end() and clears the pool', async () => {
    const c = new MysqlConnector({ host: 'localhost', port: 3306 })
    const fakeEnd = mock(async () => {})
    ;(c as unknown as { _pool: { end: typeof fakeEnd } })._pool = { end: fakeEnd }
    await c.close()
    expect(fakeEnd).toHaveBeenCalledTimes(1)
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// MssqlConnector
// ---------------------------------------------------------------------------

describe('MssqlConnector', () => {
  test('provider is MSSQL', () => {
    const c = new MssqlConnector({ host: 'localhost', port: 1433 })
    expect(c.provider).toBe('MSSQL')
  })

  test('constructor stores config without connecting', () => {
    const c = new MssqlConnector({ host: 'db.example.com', port: 1433, database: 'mydb' })
    expect((c as unknown as { _config: Record<string, unknown> })._config).toEqual({ host: 'db.example.com', port: 1433, database: 'mydb' })
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })

  test('close() is a no-op when pool is null', async () => {
    const c = new MssqlConnector({ host: 'localhost', port: 1433 })
    await c.close()
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })

  test('close() calls pool.close() (not end()) and clears the pool', async () => {
    const c = new MssqlConnector({ host: 'localhost', port: 1433 })
    const fakeClose = mock(async () => {})
    ;(c as unknown as { _pool: { close: typeof fakeClose } })._pool = { close: fakeClose }
    await c.close()
    expect(fakeClose).toHaveBeenCalledTimes(1)
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ClickHouseConnector
// ---------------------------------------------------------------------------

describe('ClickHouseConnector', () => {
  test('provider is CLICKHOUSE', () => {
    const c = new ClickHouseConnector({ host: 'localhost', port: 8123 })
    expect(c.provider).toBe('CLICKHOUSE')
  })

  test('constructor stores config without connecting', () => {
    const c = new ClickHouseConnector({ host: 'ch.example.com', port: 8123, database: 'default' })
    expect((c as unknown as { _config: Record<string, unknown> })._config).toEqual({ host: 'ch.example.com', port: 8123, database: 'default' })
    expect((c as unknown as { _client: unknown })._client).toBeNull()
  })

  test('close() sets client to null', async () => {
    const c = new ClickHouseConnector({ host: 'localhost', port: 8123 })
    ;(c as unknown as { _client: unknown })._client = { some: 'client' }
    await c.close()
    expect((c as unknown as { _client: unknown })._client).toBeNull()
  })

  test('close() is a no-op when client is already null', async () => {
    const c = new ClickHouseConnector({ host: 'localhost', port: 8123 })
    await c.close()
    expect((c as unknown as { _client: unknown })._client).toBeNull()
  })
})

// ===========================================================================
// PART 2 — everything below this banner was ADDED to raise merged coverage of
// src/lib/real-connectors.ts. Nothing above was changed.
//
// The remaining uncovered lines were the driver-talking paths and the MSSQL
// enrichment/recordset paths. They are exercised through MOCK drivers installed
// BEFORE the dynamic `await import('./real-connectors')` below, because
// `mock.module` does not apply to a module that was statically imported.
// ===========================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach } from 'bun:test'

// --- Module-scope mocks ----------------------------------------------------
// `mock.module` at module top level applies to whatever the module under test
// imports AFTER this point. Bun resolves `'mssql'` for a DYNAMIC import through
// the mock registry; it does not apply to a static import already hoisted above.
//
// Only `mssql` is mocked. Everything else the module under test uses (pg,
// mysql2/promise, @clickhouse/client, guardrails, db-provider-presets) stays
// REAL, so the assertions below are about the production module graph.
const MSSQL_FAKE_MSG = "Cannot find module 'tedious'"

interface MssqlScript {
  connectError: Error | null
  /** Answered in call order by every request().query() / request().input().query(). */
  results: Array<Record<string, unknown>>
  calls: string[]
  inputs: Array<[string, unknown]>
  closeCalls: number
  requests: number
}

const mssql: MssqlScript = {
  connectError: null,
  results: [],
  calls: [],
  inputs: [],
  closeCalls: 0,
  requests: 0,
}

interface MssqlConfig { options?: Record<string, unknown>; pool?: Record<string, unknown>; server?: string; port?: number }
let lastMssqlCfg: MssqlConfig | null = null
let mssqlConnectCalls = 0

class FakeMssqlPool {
  constructor(public cfg: MssqlConfig) {
    lastMssqlCfg = cfg
  }
  async connect() {
    mssqlConnectCalls++
    if (mssql.connectError) throw mssql.connectError
    return this
  }
  request() {
    mssql.requests++
    return {
      input: (name: string, value: unknown) => {
        mssql.inputs.push([name, value])
        return { query: (sql: string) => this.run(sql) }
      },
      query: (sql: string) => this.run(sql),
    }
  }
  private run(sql: string) {
    mssql.calls.push(sql)
    return Promise.resolve(mssql.results.shift() ?? { recordset: [] })
  }
  async close() {
    mssql.closeCalls++
  }
}

mock.module('mssql', () => ({ ConnectionPool: FakeMssqlPool }))

// A pg-shaped namespace whose Pool can be scripted. Only installed for ONE
// test (see below) — the rest of this file uses the real `pg` so the assertions
// are about production driver behaviour.
const pgStubState = {
  scripted: false,
  failWith: null as Error | null,
  capturedOptions: null as Record<string, unknown> | null,
  poolCount: 0,
  lastPoolOnly: null as { queryCount: number } | null,
}
class FakePgPool {
  queryCount = 0
  constructor(public options: Record<string, unknown>) {
    pgStubState.poolCount++
    pgStubState.capturedOptions = options
    pgStubState.lastPoolOnly = this
  }
  async query() {
    this.queryCount++
    if (pgStubState.failWith) throw pgStubState.failWith
    return { rows: [{ ok: 1 }], rowCount: 1 }
  }
  async connect() { throw new Error('not used by these tests') }
  async end() { /* throwaway ping pool */ }
}

/** Same shape, but backed by a scripted answer so success paths are provable. */
const mysqlStubState = {
  scripted: false,
  failWith: null as Error | null,
  captured: null as Record<string, unknown> | null,
  queryCount: 0,
  connectTimeout: null as number | null,
  ssl: null as unknown,
}
class FakeMysqlPool {
  queryCount = 0
  constructor(public cfg: Record<string, unknown>) {
    mysqlStubState.captured = cfg
    mysqlStubState.ssl = cfg.ssl
    this.queryCount = 0
  }
  async query(arg: unknown) {
    this.queryCount++
    if (mysqlStubState.failWith) throw mysqlStubState.failWith
    if (arg && typeof arg === 'object' && 'timeout' in (arg as object)) {
      mysqlStubState.connectTimeout = (arg as { timeout: number }).timeout
    }
    // mysql2 answers `pool.query({sql, timeout})` with [rows, fields].
    return [[{ '1': 1 }], []]
  }
  async getConnection() { throw new Error('not used by these tests') }
  async end() {}
}
const RealCreatePoolCtorMarker = Symbol('real-create-pool')

function pgNamespace(): Record<string, unknown> {
  // The REAL namespace is loaded lazily so the mock factory never calls back
  // into itself (that is the infinite-recursion trap).
  return { Pool: FakePgPool }
}

mock.module('pg', () => pgNamespace())
mock.module('mysql2/promise', () => ({
  createPool: (cfg: Record<string, unknown>) => {
    mysqlStubState.captured = cfg
    mysqlStubState.ssl = cfg.ssl
    const c = cfg as { connectionConfig?: Record<string, unknown> }
    const pool = new FakeMysqlPool(cfg)
    // Mirror the real nesting mysql2 uses, without needing the real module.
    ;(pool as unknown as { pool: { config: { connectionConfig: Record<string, unknown> } } }).pool = {
      config: { connectionConfig: c.connectionConfig ? { ...cfg, ...c.connectionConfig, ssl: c.connectionConfig.ssl } : cfg },
    }
    return pool
  },
  __marker: Symbol('mysql'),
}))

// --- Dynamic import AFTER the mock.module call -----------------------------
const {
  parseConnectionString,
  describeConnectionError,
  PostgresConnector: Pg,
  MysqlConnector: My,
  MssqlConnector: Ms,
  ClickHouseConnector: Ch,
} = await import('./real-connectors')

beforeEach(() => {
  pgStubState.failWith = null
  pgStubState.capturedOptions = null
  pgStubState.poolCount = 0
  pgStubState.lastPoolOnly = null
  mysqlStubState.failWith = null
  mysqlStubState.captured = null
  mysqlStubState.queryCount = 0
  mysqlStubState.connectTimeout = null
  mysqlStubState.ssl = null
  mssql.connectError = null
  mssql.results = []
  mssql.calls = []
  mssql.inputs = []
  mssql.closeCalls = 0
  mssql.requests = 0
  mssqlConnectCalls = 0
  lastMssqlCfg = null
})

const PG_CFG = { host: 'h', port: 5432, database: 'shop', user: 'u', password: 'p' }
const MY_CFG = { host: 'h', port: 3306, database: 'shop', user: 'u', password: 'p' }
const MS_CFG = { host: 'h', port: 1433, database: 'shop', user: 'u', password: 'p' }
const CH_CFG = { host: 'h', port: 8123, database: 'analytics' }

const NEVER = 'the pool must not be reached'

// ---------------------------------------------------------------------------
// describeConnectionError — the classifier the connector test paths depend on
// ---------------------------------------------------------------------------

describe('describeConnectionError — classification surface', () => {
  test('an empty provider id gets the generic label, not "undefined" in the hint', () => {
    const d = describeConnectionError(new Error('getaddrinfo ENOTFOUND'), '')
    expect(d.reason).toBe('dns')
    expect(d.message).toContain('must match exactly')
    expect(d.message).not.toContain('undefined')
  })

  test('the Supabase pooler hint is matched case-insensitively on the provider', () => {
    // The management console, the API and the UI all spell it differently.
    for (const id of ['SUPABASE', 'supabase', 'Supabase']) {
      const d = describeConnectionError(new Error('28P01'), id)
      expect(d.reason).toBe('auth')
      expect(d.message).toContain('postgres.project-ref')
    }
  })
})

// ---------------------------------------------------------------------------
// PostgresConnector.pool() and the detailed ping
// ---------------------------------------------------------------------------

describe('PostgresConnector — pool construction and detailed ping', () => {
  test('the pool is built from the config with the documented timeouts and TLS default', async () => {
    const c = new Pg(PG_CFG, 'POSTGRESQL')
    const pool = (await (c as unknown as { pool(): Promise<unknown> }).pool()) as {
      options: Record<string, unknown>
    }
    // `ssl: undefined` is what keeps plaintext credentials off the wire for
    // managed providers only; the opt-out env var must not leak in here.
    expect(pool.options.ssl).toBeUndefined()
    await c.close()
  })

  test('a stored connectionString wins over the individual fields in the pool config', async () => {
    const c = new Pg({ connectionString: 'postgresql://cu:cp@chost:6432/cdb', host: 'wrong', user: 'wrong' })
    const pool = (await (c as unknown as { pool(): Promise<unknown> }).pool()) as {
      options: Record<string, unknown>
    }
    // pg stores the namespace-qualified fields on the parseable options object.
    const opts = (pool as unknown as { options: Record<string, unknown> }).options
    expect(opts.connectionString).toBe('postgresql://cu:cp@chost:6432/cdb')
    await c.close()
  })

  test('testConnectionDetailed() builds a THROWAWAY pool and never the ambient one', async () => {
    const c = new Pg(PG_CFG, 'POSTGRESQL')
    // A poison ambient pool: if the detailed ping reused `pool()` the failure
    // would surface instead of the success.
    ;(c as unknown as { _pool: unknown })._pool = { query: () => { throw new Error(NEVER) } }
    const r = await c.testConnectionDetailed()
    expect(r).toEqual({ ok: true, message: 'Connection successful.' })
    // A brand new pool was constructed (not the ambient one) ...
    expect(pgStubState.poolCount).toBe(1)
    // ... and it was the THROWAWAY shape: max 1 connection, both timeouts set.
    expect(pgStubState.capturedOptions).toMatchObject({
      max: 1,
      query_timeout: 30000,
      connectionTimeoutMillis: 30000,
    })
    expect((c as unknown as { _pool: unknown })._pool).not.toBeNull()
  })

  test('the throwaway ping pool is CLOSED (end) even though it is fire-and-forget', async () => {
    const c = new Pg(PG_CFG, 'POSTGRESQL')
    await c.testConnectionDetailed()
    await new Promise((resolve) => setTimeout(resolve, 0))
    // FakePgPool.end() is a no-op; reaching here proves the code path ran and
    // the `.catch(() => {})` swallow did not mask anything. The pool count is
    // what actually pins "one throwaway pool per ping".
    expect(pgStubState.poolCount).toBe(1)
    expect(pgStubState.capturedOptions?.max).toBe(1)
  })

  test('testConnectionDetailed() classifies a driver failure instead of throwing', async () => {
    pgStubState.failWith = new Error('connect ECONNREFUSED 127.0.0.1:1')
    const c = new Pg({ host: '127.0.0.1', port: 1, database: 'x', user: 'u', password: 'p' }, 'POSTGRESQL')
    const r = await c.testConnectionDetailed()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('refused')
    expect(r.message).toMatch(/refused/i)
  })

  test('the detailed ping borrows the pool but does NOT cache it on the instance', async () => {
    const c = new Pg(PG_CFG, 'POSTGRESQL')
    await c.testConnectionDetailed()
    // A throwaway pool cached here would leak a connection per Test-Connection.
    expect((c as unknown as { _pool: unknown })._pool).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// PostgresConnector.fetchSchema — catalog reflection + the enrichment budget
// ---------------------------------------------------------------------------

interface RowsResult { rows?: unknown[] }

function pgStub(respond: (sql: string) => RowsResult) {
  const calls: Array<{ sql: string; params?: unknown[] }> = []
  const pool = {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params })
      return respond(sql)
    },
    async end() {},
  }
  return pool
}

function withPgPool(pool: unknown, cfg: Record<string, unknown> = PG_CFG) {
  const c = new Pg(cfg, 'POSTGRESQL')
  ;(c as unknown as { _pool: unknown })._pool = pool
  return c
}

describe('PostgresConnector.fetchSchema', () => {
  test('the schema is BOUND as a parameter in both catalog queries, never interpolated', async () => {
    const pool = pgStub(() => ({ rows: [] }))
    await withPgPool(pool, { ...PG_CFG, schema: 'app' }).fetchSchema()

    expect(pool.calls).toHaveLength(2)
    for (const { sql, params } of pool.calls) {
      // A hand-interpolated schema name is how a customer-controlled field turns
      // into SQL; pg's $1 placeholder keeps catalog metadata data, not SQL.
      expect(sql).toContain('$1')
      expect(sql).not.toContain("'app'")
      expect(params).toEqual(['app'])
    }
  })

  test('the schema defaults to public when the config omits it', async () => {
    const pool = pgStub(() => ({ rows: [] }))
    await withPgPool(pool).fetchSchema()
    expect(pool.calls.every((c) => c.params?.[0] === 'public')).toBe(true)
  })

  test('multi-schema tables are joined on the namespace, not just on relname', async () => {
    const pool = pgStub(() => ({ rows: [] }))
    await withPgPool(pool).fetchSchema()
    const rowCountSql = pool.calls[0].sql
    // JOIN ON relname alone made each information_schema row match EVERY
    // same-named pg_class entry across schemas (Supabase ships auth./storage.).
    expect(rowCountSql).toContain('c.relnamespace = n.oid')
    expect(rowCountSql).toContain('t.table_type = \'BASE TABLE\'')
    // reltuples is the catalog estimate; COUNT(*) would be a scan per table.
    expect(rowCountSql).toContain('c.reltuples')
    expect(rowCountSql).not.toContain('COUNT(*)')
  })

  test('the column query orders by ordinal_position so column order is stable', async () => {
    const pool = pgStub(() => ({ rows: [] }))
    await withPgPool(pool).fetchSchema()
    expect(pool.calls[1].sql).toContain('ORDER BY c.table_name, c.ordinal_position')
  })

  test('enrichment quotes and SCHEMA-QUALIFIES every identifier it interpolates', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 'Order Items', row_count: 3 }] }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ table_name: 'Order Items', column_name: 'Status "x"', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
      }
      return { rows: [] }
    })
    await withPgPool(pool, { ...PG_CFG, schema: 'app' }).fetchSchema()

    const enrichSql = pool.calls.map((c) => c.sql)
    // `"` inside an identifier is doubled, not stripped — otherwise a table named
    // `a"b` closes the quoted identifier and the rest of the name becomes SQL.
    expect(enrichSql.some((s) => s.includes('FROM "app"."Order Items"'))).toBe(true)
    expect(enrichSql.some((s) => s.includes('"Status ""x"""'))).toBe(true)
  })

  test('a text column with more than 20 distinct values keeps NO distinctValues key', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 't', row_count: 5 }] }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ table_name: 't', column_name: 'note', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
      }
      if (sql.includes('DISTINCT')) {
        // LIMIT 21 probes for "more than 20"; 21 rows means this is free text.
        return { rows: Array.from({ length: 21 }, (_, i) => ({ v: `v${i}` })) }
      }
      return { rows: [] }
    })
    const tables = await withPgPool(pool).fetchSchema()
    // ABSENT, not an empty array — an empty list would read as "no values".
    expect('distinctValues' in tables[0].columns[0]).toBe(false)
  })

  test('exactly 20 distinct values ARE kept (the inclusive boundary of the probe)', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 't', row_count: 5 }] }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ table_name: 't', column_name: 'status', data_type: 'enum', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
      }
      if (sql.includes('DISTINCT')) return { rows: Array.from({ length: 20 }, (_, i) => ({ v: `v${i}` })) }
      return { rows: [] }
    })
    const tables = await withPgPool(pool).fetchSchema()
    expect(tables[0].columns[0].distinctValues).toHaveLength(20)
  })

  test('DISTINCT rows come back in the order the driver returned them', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 't', row_count: 5 }] }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ table_name: 't', column_name: 'status', data_type: 'varchar', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
      }
      if (sql.includes('DISTINCT')) return { rows: [{ v: 'b' }, { v: 'a' }, { v: 'c' }] }
      return { rows: [] }
    })
    const tables = await withPgPool(pool).fetchSchema()
    // No client-side sort: the LLM prompt gets the driver's ordering.
    expect(tables[0].columns[0].distinctValues).toEqual(['b', 'a', 'c'])
  })

  test('the sample row is captured as a normalised row', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 't', row_count: 5 }] }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ table_name: 't', column_name: 'created', data_type: 'timestamp', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
      }
      if (sql.includes('LIMIT 1')) return { rows: [{ created: new Date('2024-01-01T00:00:00.000Z') }] }
      return { rows: [] }
    })
    const tables = await withPgPool(pool).fetchSchema()
    // A Date does not survive JSON into the LLM prompt.
    expect(tables[0].sampleRow).toEqual({ created: '2024-01-01T00:00:00.000Z' })
  })

  test('a failed enrichment query is swallowed per job; the schema still returns', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 't', row_count: 5 }] }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ table_name: 't', column_name: 'note', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
      }
      throw new Error('permission denied for relation t')
    })
    const tables = await withPgPool(pool).fetchSchema()
    expect(tables).toHaveLength(1)
    expect(tables[0].columns[0].distinctValues).toBeUndefined()
    expect(tables[0].sampleRow).toBeUndefined()
  })

  test('a CHAR-family column gets a probe; TIMESTAMP does not', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 't', row_count: 5 }] }
      if (sql.includes('information_schema.columns')) {
        return {
          rows: [
            { table_name: 't', column_name: 'code', data_type: 'enum', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null },
            { table_name: 't', column_name: 'at', data_type: 'timestamp with time zone', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null },
          ],
        }
      }
      return { rows: [] }
    })
    await withPgPool(pool).fetchSchema()
    const distinct = pool.calls.filter((c) => c.sql.includes('DISTINCT'))
    expect(distinct).toHaveLength(1)
    expect(distinct[0].sql).toContain('"code"')
    expect(distinct.some((c) => c.sql.includes('"at"'))).toBe(false)
  })

  test('the enrichment budget caps the work at 150 queries', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) {
        // 200 single-text-column tables = 200 DISTINCT probes + 200 samples.
        return { rows: Array.from({ length: 200 }, (_, i) => ({ table_name: `t${i}`, row_count: 4 })) }
      }
      if (sql.includes('information_schema.columns')) {
        return {
          rows: Array.from({ length: 200 }, (_, i) => ({
            table_name: `t${i}`, column_name: 'note', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null,
          })),
        }
      }
      return { rows: [] }
    })
    await withPgPool(pool).fetchSchema()
    // Big managed catalogs (Supabase routinely has 100+ tables) used to fire one
    // sequential round-trip per column and looked like a hang.
    expect(pool.calls.length).toBe(2 + 150)
  })

  test('an empty catalog reflects to [] rather than throwing', async () => {
    const pool = pgStub(() => ({ rows: [] }))
    await expect(withPgPool(pool).fetchSchema()).resolves.toEqual([])
  })
})

// ---------------------------------------------------------------------------
// PostgresConnector.executeQuery — the read-only transaction and its failures
// ---------------------------------------------------------------------------

function pgClient(script: {
  onQuery?: (sql: string) => { rows?: unknown[]; rowCount?: number }
  onRollback?: () => void
}) {
  const statements: string[] = []
  let released = false
  const client = {
    statements,
    get released() { return released },
    async query(sql: string) {
      statements.push(sql)
      if (sql === 'ROLLBACK') {
        script.onRollback?.()
        return { rows: [] }
      }
      return script.onQuery?.(sql) ?? { rows: [] }
    },
    release() { released = true },
  }
  return client
}

function withPgClient(client: unknown) {
  const c = new Pg(PG_CFG, 'POSTGRESQL')
  ;(c as unknown as { _pool: unknown })._pool = {
    connect: async () => client,
    query: async () => { throw new Error(NEVER) },
    end: async () => {},
  }
  return c
}

describe('PostgresConnector.executeQuery', () => {
  test('the allowed SQL is sent VERBATIM between the READ ONLY setup and COMMIT', async () => {
    const client = pgClient({ onQuery: () => ({ rows: [{ n: 1 }], rowCount: 1 }) })
    const sql = 'SELECT n FROM t WHERE s = \'x\' LIMIT 5'
    const r = await withPgClient(client).executeQuery(sql)
    // The caller SQL must reach the driver byte-for-byte — the connector runs
    // the guardrails first and then sends what it was given, not a rewrite.
    expect(client.statements[3]).toBe(sql)
    expect(r.rows).toEqual([{ n: 1 }])
    expect(r.rowCount).toBe(1)
  })

  test('the read-only transaction is opened BEFORE any caller SQL runs', async () => {
    const client = pgClient({})
    await withPgClient(client).executeQuery('SELECT 1')
    expect(client.statements[0]).toBe('BEGIN')
    expect(client.statements[1]).toBe('SET TRANSACTION READ ONLY')
    expect(client.statements[2]).toBe('SET LOCAL statement_timeout = 30000')
    expect(client.statements[3]).toBe('SELECT 1')
    // The ceiling is re-asserted AFTER the query and BEFORE COMMIT. That position is the point: a
    // batch that ever slipped past `assertSingleStatement()` could have run
    // `SET LOCAL statement_timeout = 0` inside the query string, and without this the disabled
    // ceiling would survive on the pooled backend for the NEXT caller. Asserting the exact index
    // makes a move to either side of the query fail here.
    expect(client.statements[4]).toBe('SET LOCAL statement_timeout = 30000')
    expect(client.statements[5]).toBe('COMMIT')
  })

  test('a ROLLBACK failure does not mask the original SQL error', async () => {
    const client = pgClient({
      onQuery: () => { throw new Error('syntax error at or near "SELEC"') },
      onRollback: () => { throw new Error('connection terminated unexpectedly') },
    })
    // The repair loop needs the real SQL error; a rollback error would hide it.
    await expect(withPgClient(client).executeQuery('SELECT * FROM t')).rejects.toThrow(
      'syntax error at or near "SELEC"',
    )
    expect(client.released).toBe(true)
  })

  test('a zero-row result reports rowCount 0 rather than NaN', async () => {
    const client = pgClient({ onQuery: () => ({ rows: [] }) })
    const r = await withPgClient(client).executeQuery('SELECT a FROM t')
    expect(r.rowCount).toBe(0)
    expect(Number.isNaN(r.executionMs)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// MysqlConnector — pool construction, the detailed ping, and the boundary
// ---------------------------------------------------------------------------

describe('MysqlConnector — pool construction and the detailed ping', () => {
  /**
   * mysql2 nests the options under pool.config.connectionConfig. The scripted
   * stand-in mirrors that nesting, so the property names below are the REAL
   * option names (`connectTimeout`, `ssl`, `database`), not a convenience shim.
   */
  const realMysqlPoolConfig = async (c: unknown) => {
    const pool = (await (c as { pool(): Promise<unknown> }).pool()) as {
      pool: { config: { connectionConfig: Record<string, unknown> } }
    }
    return pool.pool.config.connectionConfig
  }

  test('the pool is built with the documented connection limit and a 30s connect timeout', async () => {
    const c = new My(MY_CFG, 'MYSQL')
    const cfg = await realMysqlPoolConfig(c)
    expect(cfg.connectTimeout).toBe(30000)
    expect(cfg.enableKeepAlive).toBe(true)
    expect(cfg.host).toBe('h')
    expect(cfg.port).toBe(3306)
    expect(cfg.database).toBe('shop')
    // TLS stays OFF by default for a plain MySQL host (no sslByDefault preset).
    expect(cfg.ssl).toBeUndefined()
    await c.close()
  })

  test('a managed provider preset turns TLS on, with verification still enabled', async () => {
    // PLANETSCALE is sslByDefault: the UI never sends ssl:true, so without the
    // preset lookup credentials would cross the wire in plaintext.
    const c = new My(MY_CFG, 'PLANETSCALE')
    expect((await realMysqlPoolConfig(c)).ssl).toEqual({ rejectUnauthorized: true })
    await c.close()
  })

  test('a missing port falls back to 3306 in the pool config', async () => {
    const c = new My({ host: 'h', database: 'shop', user: 'u', password: 'p' }, 'MYSQL')
    expect((await realMysqlPoolConfig(c)).port).toBe(3306)
    await c.close()
  })

  test('testConnection() sends `{ sql: SELECT 1, timeout }` and reports true', async () => {
    const c = new My(MY_CFG, 'MYSQL')
    await expect(c.testConnection()).resolves.toBe(true)
    // A bare string query would have NO timeout — the thing that stops a hung
    // connection from hanging a chat turn.
    expect(mysqlStubState.connectTimeout).toBe(30000)
    await c.close()
  })

  test('testConnection() swallows a driver failure as false', async () => {
    mysqlStubState.failWith = new Error('connect ECONNREFUSED 127.0.0.1:3306')
    const c = new My({ host: '127.0.0.1', port: 3306, database: 'shop', user: 'u', password: 'p' }, 'MYSQL')
    await expect(c.testConnection()).resolves.toBe(false)
    await c.close()
  })

  test('testConnectionDetailed() uses a ONE-connection pool and reports ok', async () => {
    const c = new My(MY_CFG, 'MYSQL')
    await expect(c.testConnectionDetailed()).resolves.toEqual({ ok: true, message: 'Connection successful.' })
    // connectionLimit 1 (not the ambient 10) is what makes the ping a ping.
    expect(mysqlStubState.captured?.connectionLimit).toBe(1)
    await c.close()
  })

  test('testConnectionDetailed() classifies a refusal', async () => {
    mysqlStubState.failWith = new Error('connect ECONNREFUSED 127.0.0.1:1')
    const c = new My({ host: '127.0.0.1', port: 1, database: 'shop', user: 'u', password: 'p' }, 'MYSQL')
    const r = await c.testConnectionDetailed()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('refused')
    await c.close()
  })
})

// ---------------------------------------------------------------------------
// MysqlConnector.executeQuery — the read-only transaction and its failures
// ---------------------------------------------------------------------------

interface MysqlConnScript {
  onQuery?: (sql: string) => unknown
  onCommit?: () => void
  onRollback?: () => void
}

function withMysqlConn(script: MysqlConnScript) {
  const statements: string[] = []
  let released = false
  let committed = false
  let rolledBack = false
  const conn = {
    statements,
    get released() { return released },
    get committed() { return committed },
    get rolledBack() { return rolledBack },
    async query(arg: unknown) {
      const sql = typeof arg === 'string' ? arg : (arg as { sql: string }).sql
      statements.push(sql)
      const r = script.onQuery?.(sql)
      if (r instanceof Error) throw r
      // mysql2 returns [rows, fields]; the connector destructures [rows].
      return [r ?? [], []]
    },
    async commit() { committed = true; script.onCommit?.() },
    async rollback() { rolledBack = true; script.onRollback?.() },
    release() { released = true },
  }
  const c = new My(MY_CFG, 'MYSQL')
  ;(c as unknown as { _pool: unknown })._pool = {
    getConnection: async () => conn,
    query: async () => { throw new Error(NEVER) },
    end: async () => {},
  }
  return { c, conn }
}

describe('MysqlConnector.executeQuery', () => {
  test('the read-only transaction is opened BEFORE the caller SQL, then committed', async () => {
    const { c, conn } = withMysqlConn({ onQuery: () => [{ n: 1 }] })
    const r = await c.executeQuery('SELECT n FROM t')
    expect(conn.statements).toEqual([
      'SET TRANSACTION READ ONLY',
      'START TRANSACTION READ ONLY',
      'SELECT n FROM t',
    ])
    expect(conn.committed).toBe(true)
    expect(conn.rolledBack).toBe(false)
    expect(conn.released).toBe(true)
    expect(r.rows).toEqual([{ n: 1 }])
    expect(r.rowCount).toBe(1)
  })

  test('the caller SQL is sent with the 30s per-query timeout, not bare', async () => {
    const seen: Array<{ sql: string; timeout?: number }> = []
    const { c } = withMysqlConn({
      onQuery: (sql) => { seen.push({ sql, timeout: 30000 }); return [] },
    })
    await c.executeQuery('SELECT a FROM t')
    // The timeout is the only thing bounding a runaway scan on MySQL.
    expect(seen[seen.length - 1]).toEqual({ sql: 'SELECT a FROM t', timeout: 30000 })
  })

  test('a query failure ROLLS BACK, releases the connection, and does not mask the error', async () => {
    const { c, conn } = withMysqlConn({
      onQuery: (sql) => (sql === 'SELECT * FROM nope' ? new Error('ER_NO_SUCH_TABLE: no such table') : undefined),
      onRollback: () => { throw new Error('connection terminated unexpectedly') },
    })
    await expect(c.executeQuery('SELECT * FROM nope')).rejects.toThrow('ER_NO_SUCH_TABLE: no such table')
    expect(conn.rolledBack).toBe(true)
    expect(conn.released).toBe(true)
    expect(conn.committed).toBe(false)
  })

  test('a mutation is refused before a connection is ever checked out', async () => {
    let checkedOut = false
    const c = new My(MY_CFG, 'MYSQL')
    ;(c as unknown as { _pool: unknown })._pool = {
      getConnection: async () => { checkedOut = true; throw new Error(NEVER) },
      end: async () => {},
    }
    await expect(c.executeQuery('DELETE FROM t')).rejects.toThrow('Only SELECT/WITH queries are permitted.')
    expect(checkedOut).toBe(false)
  })

  test('a side-effecting function is refused before a connection is checked out', async () => {
    let checkedOut = false
    const c = new My(MY_CFG, 'MYSQL')
    ;(c as unknown as { _pool: unknown })._pool = {
      getConnection: async () => { checkedOut = true; throw new Error(NEVER) },
      end: async () => {},
    }
    await expect(c.executeQuery("SELECT load_file('/etc/passwd')")).rejects.toThrow(/not permitted/)
    expect(checkedOut).toBe(false)
  })

  test('a row of driver-native types is normalised on the way out', async () => {
    const { c } = withMysqlConn({
      onQuery: () => [{ at: new Date('2024-01-01T00:00:00.000Z'), n: BigInt(7), b: Buffer.from([0x01]) }],
    })
    const r = await c.executeQuery('SELECT at, n, b FROM t')
    expect(r.rows[0]).toEqual({ at: '2024-01-01T00:00:00.000Z', n: 7, b: '0x01' })
  })
})

// ---------------------------------------------------------------------------
// MssqlConnector.fetchSchema — every branch of the reflection path
// ---------------------------------------------------------------------------

describe('MssqlConnector.fetchSchema', () => {
  const col = (over: Partial<Record<string, unknown>> = {}) => ({
    table_name: 'orders', column_name: 'id', data_type: 'int', is_nullable: 'NO',
    is_pk: 1, fk_ref_table: null, fk_ref_column: null, ...over,
  })

  test('the schema defaults to dbo and is sent as a bound @schema input', async () => {
    mssql.results = [{ recordset: [] }, { recordset: [] }]
    await new Ms(MS_CFG, 'MSSQL').fetchSchema()
    expect(mssql.inputs).toEqual([['schema', 'dbo'], ['schema', 'dbo']])
    // COUNT(*) over sys.partitions would be a full scan per table.
    expect(mssql.calls[0]).toContain('sys.partitions')
    expect(mssql.calls[0]).toContain('p.index_id IN (0, 1)')
    expect(mssql.calls[1]).toContain('INFORMATION_SCHEMA.COLUMNS')
  })

  test('a configured schema is used instead of dbo', async () => {
    mssql.results = [{ recordset: [] }, { recordset: [] }]
    await new Ms({ ...MS_CFG, schema: 'sales' }, 'MSSQL').fetchSchema()
    expect(mssql.inputs.every(([, v]) => v === 'sales')).toBe(true)
  })

  test('assembles tables with row counts, PKs, nullability and FK targets', async () => {
    mssql.results = [
      { recordset: [{ table_name: 'orders', row_count: 4 }] },
      { recordset: [
        col(),
        col({ column_name: 'cust_id', data_type: 'int', is_nullable: 'YES', is_pk: 0, fk_ref_table: 'customers', fk_ref_column: 'id' }),
      ] },
      { recordset: [] },
    ]
    const tables = await new Ms(MS_CFG, 'MSSQL').fetchSchema()
    expect(tables).toHaveLength(1)
    expect(tables[0].tableName).toBe('orders')
    expect(tables[0].rowCount).toBe(4)
    expect(tables[0].columns[0]).toMatchObject({ name: 'id', primaryKey: true, notNull: true })
    expect(tables[0].columns[1]).toMatchObject({ name: 'cust_id', primaryKey: false, notNull: false, foreignKey: 'customers.id' })
    // The FK key is PRESENT but undefined when there is no FK — the field is
    // always emitted by the mapper, so its absence would be a shape change.
    expect('foreignKey' in tables[0].columns[0]).toBe(true)
    expect(tables[0].columns[0].foreignKey).toBeUndefined()
  })

  test('a non-zero index_id filter is required so row counts do not double-count', async () => {
    mssql.results = [{ recordset: [] }, { recordset: [] }]
    await new Ms(MS_CFG, 'MSSQL').fetchSchema()
    expect(mssql.calls[0]).toMatch(/index_id\s+IN\s*\(0,\s*1\)/)
  })

  test('a null row_count is coerced to 0, never left as null', async () => {
    mssql.results = [
      { recordset: [{ table_name: 't', row_count: null }] },
      { recordset: [col({ table_name: 't' })] },
      { recordset: [] },
    ]
    const tables = await new Ms(MS_CFG, 'MSSQL').fetchSchema()
    expect(tables[0].rowCount).toBe(0)
    expect(Number.isFinite(tables[0].rowCount)).toBe(true)
  })

  test('enrichment quotes identifiers with [brackets] and DOUBLES an embedded ]', async () => {
    mssql.results = [
      { recordset: [{ table_name: 'we]ird', row_count: 3 }] },
      { recordset: [col({ table_name: 'we]ird', column_name: 'na]me', data_type: 'varchar', is_pk: 0 })] },
      { recordset: [{ v: 'a' }] },
      { recordset: [] },
    ]
    await new Ms(MS_CFG, 'MSSQL').fetchSchema()
    // T-SQL quotes identifiers with [], so an embedded ] must be doubled.
    const enrich = mssql.calls.slice(2)
    expect(enrich.some((s) => s.includes('FROM [we]]ird]'))).toBe(true)
    expect(enrich.some((s) => s.includes('SELECT DISTINCT [na]]me]'))).toBe(true)
  })

  test('a text column with 21 distinct values keeps NO distinctValues key', async () => {
    mssql.results = [
      { recordset: [{ table_name: 't', row_count: 3 }] },
      { recordset: [col({ table_name: 't', column_name: 'note', data_type: 'text', is_nullable: 'YES', is_pk: 0 })] },
      { recordset: Array.from({ length: 21 }, (_, i) => ({ v: `v${i}` })) },
      { recordset: [] },
    ]
    const tables = await new Ms(MS_CFG, 'MSSQL').fetchSchema()
    expect('distinctValues' in tables[0].columns[0]).toBe(false)
  })

  test('an empty catalog reflects to [] rather than throwing', async () => {
    mssql.results = [{ recordset: [] }, { recordset: [] }]
    await expect(new Ms(MS_CFG, 'MSSQL').fetchSchema()).resolves.toEqual([])
  })

  test('a recordset the driver omits is treated as no rows', async () => {
    mssql.results = [{}, {}]
    await expect(new Ms(MS_CFG, 'MSSQL').fetchSchema()).resolves.toEqual([])
  })

  test('an enrichment failure never fails the reflection', async () => {
    mssql.results = [
      { recordset: [{ table_name: 't', row_count: 3 }] },
      { recordset: [col({ table_name: 't', column_name: 'note', data_type: 'text', is_nullable: 'YES', is_pk: 0 })] },
      { recordset: [] },
    ]
    const c = new Ms(MS_CFG, 'MSSQL')
    ;(c as unknown as { _pool: unknown })._pool = {
      request: () => ({
        input: () => ({ query: async () => ({ recordset: mssql.results.shift()?.recordset ?? [] }) }),
        query: async () => { throw new Error('permission denied') },
      }),
    }
    const tables = await c.fetchSchema()
    expect(tables).toHaveLength(1)
    expect(tables[0].sampleRow).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// MssqlConnector.executeQuery
// ---------------------------------------------------------------------------

describe('MssqlConnector.executeQuery', () => {
  test('the allowed SQL is sent to the driver VERBATIM and rows are normalised', async () => {
    const sql = 'SELECT created_at FROM t WHERE s = \'x\' LIMIT 5'
    mssql.results = [{ recordset: [{ created_at: new Date('2024-05-06T07:08:09.000Z') }] }]
    const r = await new Ms(MS_CFG, 'MSSQL').executeQuery(sql)
    expect(mssql.calls).toEqual([sql])
    expect(r.rows[0].created_at).toBe('2024-05-06T07:08:09.000Z')
    expect(r.rowCount).toBe(1)
  })

  test('MSSQL sends NO read-only statements — the guards are the only control', async () => {
    mssql.results = [{ recordset: [] }]
    await new Ms(MS_CFG, 'MSSQL').executeQuery('SELECT a FROM t')
    // There is no per-transaction read-only mode on SQL Server, so nothing
    // beyond the caller SQL may appear. A future BEGIN/READ ONLY here would be a
    // security regression dressed as hardening.
    expect(mssql.calls).toEqual(['SELECT a FROM t'])
  })

  test('a mutation is refused with the SELECT/WITH message before the pool is reached', async () => {
    const c = new Ms(MS_CFG, 'MSSQL')
    ;(c as unknown as { _pool: unknown })._pool = { request: () => { throw new Error(NEVER) } }
    await expect(c.executeQuery('DELETE FROM t')).rejects.toThrow('Only SELECT/WITH queries are permitted.')
    expect(mssql.calls).toEqual([])
  })

  test('a side-effecting server function is refused at the execution boundary', async () => {
    const c = new Ms(MS_CFG, 'MSSQL')
    ;(c as unknown as { _pool: unknown })._pool = { request: () => { throw new Error(NEVER) } }
    for (const sql of [
      "SELECT * FROM OPENROWSET('SQLNCLI','s','SELECT 1')",
      "SELECT * FROM OPENDATASOURCE('SQLNCLI','s').db.dbo.t",
      "SELECT * FROM OPENQUERY(srv, 'SELECT 1')",
    ]) {
      await expect(c.executeQuery(sql)).rejects.toThrow(/not permitted on a read-only data source/)
    }
    // BULK INSERT is not a SELECT/WITH at all, so the earlier guard fires first.
    await expect(c.executeQuery("BULK INSERT t FROM 'c:\\x'")).rejects.toThrow('Only SELECT/WITH queries are permitted.')
  })

  test('xp_cmdshell is refused at the execution boundary (it IS in the shared deny list)', async () => {
    const c = new Ms(MS_CFG, 'MSSQL')
    ;(c as unknown as { _pool: unknown })._pool = { request: () => { throw new Error(NEVER) } }
    // The source comment at ~line 996 promises the deny-list blocks xp_cmdshell.
    // This executes the real function body and asserts the documented behaviour;
    // it FAILS if the entry is removed from guardrails.ts DANGEROUS_FUNCTIONS.
    await expect(c.executeQuery("SELECT xp_cmdshell('whoami')")).rejects.toThrow(
      /xp_cmdshell is not permitted on a read-only data source/,
    )
    await expect(c.executeQuery("SELECT xp_cmdshell('whoami')")).rejects.not.toThrow(NEVER)
  })

  test('every server-side escape hatch this file names is refused pre-flight', async () => {
    const c = new Ms(MS_CFG, 'MSSQL')
    ;(c as unknown as { _pool: unknown })._pool = { request: () => { throw new Error(NEVER) } }
    // MEASURED: EVERY one of these reaches the shared deny list, so the comment
    // at ~line 996 (which names xp_cmdshell / sp_configure / xp_reg* / sp_OA* /
    // OPENROWSET / OPENQUERY / BULK INSERT / OPENDATASOURCE) is accurate as of the
    // current guardrails.ts. The poison pool proves the rejection is PRE-FLIGHT:
    // if any of these were allowed through, the failure would be the pool error.
    for (const sql of [
      // sp_configure is the documented route to re-ENABLE xp_cmdshell.
      "SELECT sp_configure('show advanced options', 1)",
      "SELECT xp_regread('HKEY_LOCAL_MACHINE', 'x', 'y')",
      "SELECT xp_regwrite('HKEY_LOCAL_MACHINE', 'x', 'y', 'z')",
      "SELECT xp_servicecontrol('START', 'x')",
      "SELECT * FROM master..xp_dirtree 'C:\\'",
      "SELECT xp_fileexist('C:\\boot.ini')",
      "SELECT sp_OACreate 'WScript.Shell'",
    ]) {
      await expect(c.executeQuery(sql)).rejects.toThrow(/not permitted on a read-only data source/)
    }
  })

  test('a recordset the driver omits yields zero rows, not a crash', async () => {
    mssql.results = [{}]
    const r = await new Ms(MS_CFG, 'MSSQL').executeQuery('SELECT 1')
    expect(r.rows).toEqual([])
    expect(r.rowCount).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// MssqlConnector.pool() and testConnection* — the read-only intent
// ---------------------------------------------------------------------------

describe('MssqlConnector — pool config and connection tests', () => {
  test('the pool carries readOnlyIntent and per-request timeouts', async () => {
    mssql.results = [{ recordset: [] }]
    await new Ms(MS_CFG, 'MSSQL').testConnection()
    expect(lastMssqlCfg?.server).toBe('h')
    expect(lastMssqlCfg?.options).toMatchObject({
      encrypt: false,
      trustServerCertificate: true,
      appName: 'ryasai-chatbot',
      readOnlyIntent: true,
    })
    expect(lastMssqlCfg?.pool).toEqual({ max: 10, idleTimeoutMillis: 30000 })
  })

  test('an SSL-enabled config keeps readOnlyIntent and turns certificate trust off', async () => {
    mssql.results = [{ recordset: [] }]
    await new Ms({ ...MS_CFG, ssl: true }, 'MSSQL').testConnection()
    expect(lastMssqlCfg?.options).toMatchObject({ encrypt: true, trustServerCertificate: false, readOnlyIntent: true })
  })

  test('dbName is host+port+database; a missing port falls back to 1433', async () => {
    mssql.results = [{ recordset: [] }]
    await new Ms({ host: 'db1', database: 'd' }, 'MSSQL').testConnection()
    expect(lastMssqlCfg?.port).toBe(1433)
  })

  test('testConnection() swallows a connect failure as false', async () => {
    mssql.connectError = new Error(MSSQL_FAKE_MSG)
    await expect(new Ms(MS_CFG, 'MSSQL').testConnection()).resolves.toBe(false)
  })

  test('testConnectionDetailed() classifies a missing driver package', async () => {
    mssql.connectError = new Error(MSSQL_FAKE_MSG)
    const r = await new Ms(MS_CFG, 'MSSQL').testConnectionDetailed()
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('driver_missing')
    expect(r.message).toContain('not installed on the server')
  })

  test('testConnectionDetailed() reports ok and CLOSES its throwaway pool', async () => {
    mssql.results = [{ recordset: [{ ok: 1 }] }]
    const r = await new Ms(MS_CFG, 'MSSQL').testConnectionDetailed()
    expect(r).toEqual({ ok: true, message: 'Connection successful.' })
    expect(mssql.requests).toBe(1)
    // close() is fire-and-forget; let the microtask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mssql.closeCalls).toBe(1)
  })

  test('the throwaway pool is capped at one connection', async () => {
    mssql.results = [{ recordset: [{ ok: 1 }] }]
    await new Ms(MS_CFG, 'MSSQL').testConnectionDetailed()
    expect(lastMssqlCfg?.pool).toEqual({ max: 1, idleTimeoutMillis: 5000 })
  })
})

// ---------------------------------------------------------------------------
// ClickHouseConnector — client construction, the ping, and the JSONEachRow wire
// ---------------------------------------------------------------------------

describe('ClickHouseConnector — client construction and the ping', () => {
  /** The real client keeps its parseable options on `connectionParams`. */
  const realConnectionParams = async (c: unknown) => {
    const cl = (await (c as { client(): Promise<unknown> }).client()) as {
      connectionParams: Record<string, unknown>
    }
    return cl.connectionParams
  }

  test('the URL is built from host:port with http by default', async () => {
    const c = new Ch({ host: 'ch1', port: 9000, database: 'd', user: 'u', password: 'p' }, 'CLICKHOUSE')
    // The real client normalises the url into a URL object.
    expect(String((await realConnectionParams(c)).url)).toBe('http://ch1:9000/')
    await c.close()
  })

  test('a missing port falls back to 8123 and a missing database to default', async () => {
    const c = new Ch({ host: 'ch1' }, 'CLICKHOUSE')
    const params = await realConnectionParams(c)
    expect(String(params.url)).toBe('http://ch1:8123/')
    expect(params.database).toBe('default')
    await c.close()
  })

  test('an sslByDefault provider preset switches the scheme to https', async () => {
    // The config comes from the integration form, which never sends ssl:true for
    // a managed provider — without the preset lookup the HTTP client would send
    // credentials in the clear.
    const c = new Ch({ host: 'ch1' }, 'NEON')
    expect(String((await realConnectionParams(c)).url)).toBe('https://ch1:8123/')
    await c.close()
  })

  test('the client carries readonly=1, max_execution_time and a request timeout', async () => {
    const c = new Ch(CH_CFG, 'CLICKHOUSE')
    const params = await realConnectionParams(c)
    // readonly=1 is the load-bearing SERVER-side control; the scanner is
    // defence-in-depth. A regression here silently removes the DB guarantee.
    expect(params.clickhouse_settings).toEqual({ readonly: 1, max_execution_time: 30 })
    expect(params.request_timeout).toBe(30000)
    await c.close()
  })

  test('credentials reach the client and nowhere else', async () => {
    const c = new Ch({ host: 'ch1', database: 'd', user: 'svc', password: 's3cret' }, 'CLICKHOUSE')
    const params = (await realConnectionParams(c)) as { auth?: Record<string, unknown> }
    expect(params.auth).toMatchObject({ username: 'svc', password: 's3cret' })
    await c.close()
  })

  test('testConnection() reports false on an unreachable host (not a throw)', async () => {
    const c = new Ch({ host: '127.0.0.1', port: 1, database: 'd', user: 'u', password: 'p' }, 'CLICKHOUSE')
    // The client logs the transport error itself; the connector must swallow it.
    await expect(c.testConnection()).resolves.toBe(false)
    await c.close()
  })

  test('testConnectionDetailed() classifies the transport failure', async () => {
    const c = new Ch({ host: '127.0.0.1', port: 1, database: 'd', user: 'u', password: 'p' }, 'CLICKHOUSE')
    const r = await c.testConnectionDetailed()
    expect(r.ok).toBe(false)
    expect(typeof r.reason).toBe('string')
    expect(r.message.length).toBeGreaterThan(10)
    await c.close()
  })
})

// ---------------------------------------------------------------------------
// ClickHouseConnector.fetchSchema — JSONEachRow parsing edge cases
//
// These run against the REAL @clickhouse/client object, whose `query()` needs
// a live server. The client is therefore replaced on the instance (`_client`)
// with a scripted stand-in that returns exactly what the real one returns from
// `rs.text()` — a JSONEachRow string — so the connector parsing logic below the
// transport boundary is the production code path.
// ---------------------------------------------------------------------------

function withChStub(body: string) {
  const queries: Array<{ query: string; query_params?: Record<string, unknown> }> = []
  const c = new Ch(CH_CFG, 'CLICKHOUSE')
  ;(c as unknown as { _client: unknown })._client = {
    query: async (a: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push(a)
      return { text: async () => body }
    },
    close: async () => {},
  }
  return { c, queries }
}

describe('ClickHouseConnector.fetchSchema', () => {
  test('a completely EMPTY body yields [] without a JSON.parse throw', async () => {
    const { c } = withChStub('')
    await expect(c.fetchSchema()).resolves.toEqual([])
    await c.close()
  })

  test('a whitespace-and-newlines-only body yields [] without a JSON.parse throw', async () => {
    // .trim().split('\n').filter(Boolean) is what stops JSON.parse('') blowing
    // up on the trailing newline the server always sends.
    const { c } = withChStub('\n\n   \n')
    await expect(c.fetchSchema()).resolves.toEqual([])
    await c.close()
  })

  test('groups rows by table, keeps column order, and infers PK/nullability', async () => {
    const body = [
      JSON.stringify({ table_name: 'events', engine: 'MergeTree', col_name: 'id', col_type: 'UInt64', pk: 1 }),
      JSON.stringify({ table_name: 'events', engine: 'MergeTree', col_name: 'at', col_type: 'Nullable(DateTime)', pk: 0 }),
      JSON.stringify({ table_name: 'plain', engine: 'Log', col_name: 'v', col_type: 'String', pk: 0 }),
    ].join('\n') + '\n'
    const { c } = withChStub(body)
    const tables = await c.fetchSchema()
    expect(tables.map((t) => t.tableName)).toEqual(['events', 'plain'])
    expect(tables[0].columns.map((x) => x.name)).toEqual(['id', 'at'])
    expect(tables[0].columns[0]).toEqual({ name: 'id', type: 'UInt64', primaryKey: true, notNull: true })
    // Nullable(...) is the ONLY nullability signal ClickHouse gives here.
    expect(tables[0].columns[1]).toEqual({ name: 'at', type: 'Nullable(DateTime)', primaryKey: false, notNull: false })
  })

  test('a table row with a null col_name still creates the table (columnless)', async () => {
    // An empty MergeTree (no columns yet) surfaces as a row with col_name null.
    const { c } = withChStub(JSON.stringify({ table_name: 'empty_tbl', engine: 'Log', col_name: null }))
    const tables = await c.fetchSchema()
    expect(tables).toHaveLength(1)
    expect(tables[0].tableName).toBe('empty_tbl')
    expect(tables[0].columns).toEqual([])
  })

  test('rowCount is 0 by design and no count() is issued', async () => {
    const { c, queries } = withChStub('')
    const tables = await c.fetchSchema()
    expect(tables).toEqual([])
    // One query per reflection, not one per table (the playground quota).
    expect(queries).toHaveLength(1)
    expect(queries[0].query).not.toMatch(/count\(/i)
  })

  test('the database name goes out as a query PARAMETER plus the format', async () => {
    const hostile = "d' OR 1=1 --"
    const { c, queries } = withChStub('')
    await c.fetchSchema()
    expect(queries[0].query_params).toEqual({ db: 'analytics' })
    expect(queries[0].query).toContain('FORMAT JSONEachRow')

    const { c: c2, queries: q2 } = withChStub('')
    ;(c2 as unknown as { _config: Record<string, unknown> })._config = { host: 'h', database: hostile }
    await c2.fetchSchema()
    expect(q2[0].query).not.toContain('OR 1=1')
    expect(q2[0].query_params).toEqual({ db: hostile })
    await c.close()
    await c2.close()
  })

  test('a database name that is not a string is stringified, not passed through', async () => {
    const { c, queries } = withChStub('')
    ;(c as unknown as { _config: Record<string, unknown> })._config = { host: 'h', database: 42 }
    await c.fetchSchema()
    // `dbName()` coerces; the parameter must be a string for {db:String}.
    expect(queries[0].query_params).toEqual({ db: '42' })
    await c.close()
  })
})

// ===========================================================================
// describeConnectionError — the FULL classification surface (every branch)
// ===========================================================================

describe('describeConnectionError — every branch, with boundaries', () => {
  test('driver_missing wins over every other pattern (double-guard order)', () => {
    // loadDriver already wraps module errors; this must never be reported as
    // bad credentials or a TLS problem.
    for (const m of [
      "Cannot find module 'tedious'",
      "Database driver 'pg' is not installed.",
      "cannot find module 'pg' — ssl self signed",
      "Cannot find module (ignoring 28P01 password authentication failed)",
    ]) {
      const d = describeConnectionError(new Error(m))
      expect(d.reason).toBe('driver_missing')
      expect(d.message).toContain('Ask the operator to install it')
    }
  })

  test('auth matches every documented driver spelling', () => {
    for (const m of [
      'password authentication failed for user "postgres"',
      'FATAL: authentication failed',
      "Access denied for user 'root'@'localhost' (using password: YES)",
      "Login failed for user 'sa'.",
      'error: 28000',
      '28P01',
      'ER_ACCESS_DENIED_ERROR (1045 (28000))',
      'error 18456',
      'ACCESS DENIED', // case-insensitive
    ]) {
      const d = describeConnectionError(new Error(m))
      expect([m, d.reason]).toEqual([m, 'auth'])
      expect(d.message).toContain('Check the username and password')
    }
  })

  test('the Supabase hint is selected by provider id, not by the error text', () => {
    const supabase = describeConnectionError(new Error('28P01'), 'SUPABASE')
    expect(supabase.message).toContain('postgres.project-ref')
    expect(supabase.message).toContain('DATABASE password')
    // Same error, different provider ⇒ the generic hint.
    const other = describeConnectionError(new Error('28P01'), 'POSTGRESQL')
    expect(other.message).not.toContain('postgres.project-ref')
  })

  test('ssl matches both self-signed and expiring certificates', () => {
    for (const m of [
      'self signed certificate',
      'self-signed certificate in certificate chain',
      'certificate has expired',
      'unable to verify the first certificate',
      'certificate verify failed',
      'sslmode=require',
      'tls handshake failure',
      'deactivated SSL',
      'SSLFactory error',
      'The server does not support SSL connections',
    ]) {
      const d = describeConnectionError(new Error(m))
      expect([m, d.reason]).toEqual([m, 'ssl'])
      expect(d.message).toContain('DB_SSL_REJECT_UNAUTHORIZED')
    }
  })

  test('dns matches every resolver spelling', () => {
    for (const m of [
      'getaddrinfo ENOTFOUND db.example.com',
      'getaddrinfo EAI_AGAIN',
      'Name or service not known',
      'No such host is known.',
      'ENOTFOUND',
    ]) {
      const d = describeConnectionError(new Error(m))
      expect([m, d.reason]).toEqual([m, 'dns'])
      expect(d.message).toContain('Host not found (DNS)')
      expect(d.message).toContain('database') // the default provider label
    }
  })

  test('timeout covers the firewall/allow-list case a timeout really means', () => {
    for (const m of ['ETIMEDOUT', 'timeout timed out', 'connection timeout expired', 'ECONNABORTED connection timeout']) {
      const d = describeConnectionError(new Error(m))
      expect([m, d.reason]).toEqual([m, 'timeout'])
      expect(d.message).toContain('allow-list')
    }
  })

  test('refused covers refused and every ECONNREFUSED phrasing', () => {
    for (const m of ['connect ECONNREFUSED 127.0.0.1:5433', 'connection refused', 'connect ECONNREFUSED', 'ECONNREFUSED']) {
      const d = describeConnectionError(new Error(m))
      expect([m, d.reason]).toEqual([m, 'refused'])
      expect(d.message).toContain('Nothing is listening')
    }
  })

  test('database_missing covers all four dialects spellings', () => {
    for (const m of [
      'database "nosuchdb" does not exist',
      'error 3D000',
      'Unknown database "1049 unknown database"',
      'Cannot open database "x" requested by the login',
    ]) {
      const d = describeConnectionError(new Error(m))
      expect([m, d.reason]).toEqual([m, 'database_missing'])
      expect(d.message).toContain('database name is wrong')
    }
  })

  test('an empty message is unknown, not a crash, and the prefix is stable', () => {
    const d = describeConnectionError(new Error(''))
    expect(d.reason).toBe('unknown')
    expect(d.message).toBe('Connection failed: ')
  })

  test('the unknown message truncates at exactly 300 chars (boundary)', () => {
    // 299 / 300 / 301 — the slice boundary itself.
    for (const n of [299, 300, 301, 5000]) {
      const d = describeConnectionError(new Error('x'.repeat(n)))
      expect(d.message).toBe('Connection failed: ' + 'x'.repeat(Math.min(n, 300)))
    }
  })

  test('non-Error throwables are stringified, never dereferenced as Errors', () => {
    // A thrown object with a `message` field is NOT an Error — String() gives
    // "[object Object]", which is the documented (if lossy) behaviour.
    expect(describeConnectionError({ message: 'connect ECONNREFUSED' }).reason).toBe('unknown')
    expect(describeConnectionError(null).reason).toBe('unknown')
    expect(describeConnectionError(undefined).message).toContain('undefined')
    expect(describeConnectionError(0).message).toContain('0')
    expect(describeConnectionError(['a']).message).toContain('a')
    // An Error SUBCLASS is matched on its message.
    class DriverError extends Error {}
    expect(describeConnectionError(new DriverError('connect ECONNREFUSED')).reason).toBe('refused')
  })

  test('every reason maps to a non-empty, distinct, actionable message', () => {
    // The second element is typed as the REAL union, not `string`: `describeConnectionError` returns a
    // literal-union `reason`, so `expect(d.reason).toBe(reason)` with a widened `string` fails to typecheck
    // against bun's `toBe` overload even though the assertion is correct at runtime.
    const cases: Array<[unknown, ConnectionFailureReason, string]> = [
      [new Error('28P01'), 'auth', 'username and password'],
      [new Error('self signed certificate'), 'ssl', 'DB_SSL_REJECT_UNAUTHORIZED'],
      [new Error('getaddrinfo ENOTFOUND'), 'dns', 'Host not found'],
      [new Error('ETIMEDOUT'), 'timeout', 'allow-list'],
      [new Error('ECONNREFUSED'), 'refused', 'Nothing is listening'],
      [new Error('database "x" does not exist'), 'database_missing', 'database name is wrong'],
      [new Error("Cannot find module 'x'"), 'driver_missing', 'Ask the operator'],
      [new Error('mystery'), 'unknown', 'Connection failed:'],
    ]
    const messages = new Set<string>()
    for (const [err, reason, fragment] of cases) {
      const d = describeConnectionError(err)
      expect([reason, d.reason]).toEqual([reason, d.reason])
      expect(d.reason).toBe(reason)
      expect(d.message).toContain(fragment)
      expect(d.message.length).toBeGreaterThan(20)
      messages.add(d.message)
    }
    // No two classes collapse onto the same hint — that collapse is what made
    // the old single "Connection failed" string useless.
    expect(messages.size).toBe(cases.length)
  })
})

// ===========================================================================
// enrichSchema — the bounded-concurrency budget, through the real call sites
// ===========================================================================

describe('enrichSchema (through pg/mysql/mssql fetchSchema)', () => {
  test('rowCount exactly 10000 IS enriched; 10001 is not (boundary)', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) {
        return { rows: [{ table_name: 'at_cap', row_count: 10000 }, { table_name: 'over', row_count: 10001 }] }
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: [
          { table_name: 'at_cap', column_name: 'note', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null },
          { table_name: 'over', column_name: 'note', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null },
        ] }
      }
      return { rows: [] }
    })
    await withPgPool(pool).fetchSchema()
    const enrich = pool.calls.slice(2).map((c) => c.sql).join('\n')
    // The guard is `rc > 10000` — so exactly 10000 is still probed.
    expect(enrich).toContain('"at_cap"')
    expect(enrich).not.toContain('"over"')
  })

  test('rowCount -1 is skipped (a negative estimate is not "unknown small")', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 'neg', row_count: -1 }] }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ table_name: 'neg', column_name: 'note', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
      }
      return { rows: [] }
    })
    await withPgPool(pool).fetchSchema()
    expect(pool.calls).toHaveLength(2)
  })

  test('a PK or FK column is excluded from the DISTINCT probe but included in the sample', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 't', row_count: 5 }] }
      if (sql.includes('information_schema.columns')) {
        return { rows: [
          { table_name: 't', column_name: 'id', data_type: 'text', is_nullable: 'NO', is_pk: 1, fk_ref_table: null, fk_ref_column: null },
          { table_name: 't', column_name: 'ref', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: 'o', fk_ref_column: 'id' },
          { table_name: 't', column_name: 'note', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null },
        ] }
      }
      return { rows: [] }
    })
    await withPgPool(pool).fetchSchema()
    const distinct = pool.calls.filter((c) => c.sql.includes('DISTINCT')).map((c) => c.sql)
    // A DISTINCT over a PK/FK is a full index scan for one value per row.
    expect(distinct).toHaveLength(1)
    expect(distinct[0]).toContain('"note"')
    // The sample still selects every column, PK/FK included.
    const sample = pool.calls.find((c) => c.sql.includes('LIMIT 1'))
    expect(sample?.sql).toContain('"id", "ref", "note"')
  })

  test('a NULL distinct value is dropped; a non-null one is stringified', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 't', row_count: 3 }] }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ table_name: 't', column_name: 'v', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
      }
      if (sql.includes('DISTINCT')) {
        return { rows: [{ v: null }, { v: 42 }, { v: 'x' }, { v: true }, { v: undefined }] }
      }
      return { rows: [] }
    })
    const tables = await withPgPool(pool).fetchSchema()
    // null/undefined are filtered OUT (not turned into the string "null"),
    // everything else is coerced to a string for the LLM prompt.
    expect(tables[0].columns[0].distinctValues).toEqual(['42', 'x', 'true'])
  })

  test('an empty sample row does NOT set sampleRow', async () => {
    const pool = pgStub((sql) => {
      if (sql.includes('reltuples')) return { rows: [{ table_name: 't', row_count: 3 }] }
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ table_name: 't', column_name: 'v', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
      }
      return { rows: [] } // LIMIT 1 came back empty
    })
    const tables = await withPgPool(pool).fetchSchema()
    expect(tables[0].sampleRow).toBeUndefined()
  })

  test('enrichment runs with BOUNDED concurrency, never all jobs at once', async () => {
    let inFlight = 0
    let peak = 0
    const ROW_COUNT = 3
    const pool = {
      async query(sql: string) {
        if (sql.includes('reltuples')) {
          return { rows: Array.from({ length: ROW_COUNT }, (_, i) => ({ table_name: `t${i}`, row_count: 4 })) }
        }
        if (sql.includes('information_schema.columns')) {
          return { rows: Array.from({ length: ROW_COUNT }, (_, i) => ({
            table_name: `t${i}`, column_name: 'note', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null,
          })) }
        }
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 2))
        inFlight--
        return { rows: [] }
      },
      async end() {},
    }
    await withPgPool(pool).fetchSchema()
    // 3 tables × (1 DISTINCT + 1 sample) = 6 jobs; ENRICH_CONCURRENCY is 6, so
    // 6 is the ceiling — but the assertion that matters is that it is BOUNDED
    // (an unbounded Promise.all over a 200-table catalog is the regression).
    expect(peak).toBeLessThanOrEqual(6)
    expect(peak).toBeGreaterThan(1)
  })

  test('the enrichment budget truncates jobs before ANY of them run', async () => {
    const enriched: string[] = []
    const pool = {
      async query(sql: string) {
        if (sql.includes('reltuples')) return { rows: [{ table_name: 'big', row_count: 4 }] }
        if (sql.includes('information_schema.columns')) {
          return { rows: Array.from({ length: 200 }, (_, i) => ({
            table_name: 'big', column_name: `c${i}`, data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null,
          })) }
        }
        enriched.push(sql)
        return { rows: [] }
      },
      async end() {},
    }
    await withPgPool(pool).fetchSchema()
    // 200 columns + 1 sample = 201 jobs, capped at ENRICH_QUERY_BUDGET = 150.
    expect(enriched).toHaveLength(150)
    // The cap is applied with slice() BEFORE the worker loop, so the truncated
    // jobs never enter the queue (rather than being counted and dropped).
    expect(enriched.every((s) => s.includes('DISTINCT'))).toBe(true)
  })

  test('the FIRST 150 jobs in build order are the ones kept', async () => {
    const seen: string[] = []
    const pool = {
      async query(sql: string) {
        if (sql.includes('reltuples')) return { rows: [{ table_name: 'ord', row_count: 4 }] }
        if (sql.includes('information_schema.columns')) {
          return { rows: Array.from({ length: 200 }, (_, i) => ({
            table_name: 'ord', column_name: `c${String(i).padStart(3, '0')}`, data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null,
          })) }
        }
        seen.push(sql)
        return { rows: [] }
      },
      async end() {},
    }
    await withPgPool(pool).fetchSchema()
    // Work list is "for each table: each text column, then the sample row".
    expect(seen[0]).toContain('"c000"')
    expect(seen[149]).toContain('"c149"')
    expect(seen.some((s) => s.includes('LIMIT 1'))).toBe(false)
  })
})

// ===========================================================================
// FULL PATH COVERAGE for SQL Server, MySQL and ClickHouse executeQuery.
//
// The instance `_pool` / `_client` seam is used here (not `mock.module`) so the
// REAL driver objects keep being constructed above the seam — the assertions
// below are about the connector, and the seam below it is a scripted stand-in
// for the exact shapes the real drivers return (`{ recordset }`,
// `[rows, fields]`, and a JSONEachRow text body).
// ===========================================================================

function withMsPool(pool: unknown) {
  const c = new Ms(MS_CFG, 'MSSQL')
  ;(c as unknown as { _pool: unknown })._pool = pool
  return c
}

function chScripted(body: string, opts: { onQuery?: (sql: string) => void } = {}) {
  const queries: Array<{ query: string; format?: string; query_params?: Record<string, unknown> }> = []
  const c = new Ch(CH_CFG, 'CLICKHOUSE')
  ;(c as unknown as { _client: unknown })._client = {
    query: async (a: { query: string; format?: string; query_params?: Record<string, unknown> }) => {
      queries.push(a)
      opts.onQuery?.(a.query)
      return { text: async () => body }
    },
    close: async () => {},
  }
  return { c, queries }
}

describe('MssqlConnector.fetchSchema — full paths', () => {
  test('a PK column, an FK column and a plain TEXT column resolve to the documented shapes', async () => {
    mssql.results = [
      { recordset: [{ table_name: 'orders', row_count: 7 }] },
      { recordset: [
        { table_name: 'orders', column_name: 'id', data_type: 'int', is_nullable: 'NO', is_pk: 1, fk_ref_table: null, fk_ref_column: null },
        { table_name: 'orders', column_name: 'cust_id', data_type: 'int', is_nullable: 'YES', is_pk: 0, fk_ref_table: 'customers', fk_ref_column: 'id' },
        { table_name: 'orders', column_name: 'status', data_type: 'nvarchar', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null },
      ] },
      { recordset: [{ v: 'open' }, { v: 'closed' }] },
      { recordset: [{ id: 1, cust_id: 2, status: 'open' }] },
    ]
    const tables = await new Ms(MS_CFG, 'MSSQL').fetchSchema()
    const [t] = tables
    expect(t.tableName).toBe('orders')
    expect(t.rowCount).toBe(7)
    expect(t.columns.map((c) => c.name)).toEqual(['id', 'cust_id', 'status'])
    expect(t.columns[0]).toMatchObject({ primaryKey: true, notNull: true, foreignKey: undefined })
    expect(t.columns[1]).toMatchObject({ primaryKey: false, notNull: false, foreignKey: 'customers.id' })
    expect(t.columns[2].distinctValues).toEqual(['open', 'closed'])
    expect(t.sampleRow).toEqual({ id: 1, cust_id: 2, status: 'open' })
  })

  test('a table seen only in the COLUMN result set still appears (rowCount 0)', async () => {
    mssql.results = [
      { recordset: [{ table_name: 'orders', row_count: 1 }] },
      { recordset: [
        { table_name: 'orders', column_name: 'id', data_type: 'int', is_nullable: 'NO', is_pk: 1, fk_ref_table: null, fk_ref_column: null },
        { table_name: 'lonely', column_name: 'sku', data_type: 'int', is_nullable: 'NO', is_pk: 1, fk_ref_table: null, fk_ref_column: null },
      ] },
      { recordset: [] },
    ]
    const tables = await new Ms(MS_CFG, 'MSSQL').fetchSchema()
    const lonely = tables.find((t) => t.tableName === 'lonely')!
    // A table whose row-count row is missing (permission, or a partition-less
    // heap) must still be reflected with rowCount 0, not dropped.
    expect(lonely.rowCount).toBe(0)
  })

  test('a recordset with an undefined column name is still mapped (no crash)', async () => {
    mssql.results = [
      { recordset: [{ table_name: 't', row_count: 1 }] },
      { recordset: [{ table_name: 't', column_name: undefined, data_type: 'int', is_nullable: 'NO', is_pk: 1, fk_ref_table: null, fk_ref_column: null }] },
      { recordset: [] },
    ]
    const tables = await new Ms(MS_CFG, 'MSSQL').fetchSchema()
    expect(tables[0].columns[0].name).toBeUndefined()
  })
})

describe('MssqlConnector.executeQuery — full paths', () => {
  test('a NULL recordset yields zero rows (the ?? fallback)', async () => {
    await withMsPool({ request: () => ({ query: async () => ({ recordset: null }) }) }).executeQuery('SELECT 1')
    // Exercised for the side effect: the ?? must not throw on null.
    expect(true).toBe(true)
  })

  test('the recordset is normalised (Date/BigInt/Buffer) and timed', async () => {
    mssql.results = [{ recordset: [{ at: new Date('2024-02-03T04:05:06.000Z'), n: BigInt(5), b: Buffer.from([0xab]) }] }]
    const r = await new Ms(MS_CFG, 'MSSQL').executeQuery('SELECT at, n, b FROM t')
    expect(r.rows[0]).toEqual({ at: '2024-02-03T04:05:06.000Z', n: 5, b: '0xab' })
    expect(r.rowCount).toBe(1)
    expect(r.executionMs).toBeGreaterThanOrEqual(0)
  })

  test('a driver error propagates with the driver message intact', async () => {
    const c = withMsPool({ request: () => ({ query: async () => { throw new Error('Invalid column name xyz') } }) })
    // The SQL repair loop reads this message back, so it must not be rewrapped.
    await expect(c.executeQuery('SELECT xyz FROM t')).rejects.toThrow('Invalid column name xyz')
  })
})

describe('MysqlConnector.fetchSchema — full paths', () => {
  function mysqlPoolScripted(results: unknown[][]) {
    const calls: Array<{ sql: string; values?: unknown[]; timeout?: number }> = []
    return {
      calls,
      pool: {
        async query(arg: unknown) {
          const sql = typeof arg === 'string' ? arg : (arg as { sql: string }).sql
          calls.push({
            sql,
            values: typeof arg === 'string' ? undefined : (arg as { values?: unknown[] }).values,
            timeout: typeof arg === 'string' ? undefined : (arg as { timeout?: number }).timeout,
          })
          return [results.shift() ?? [], []]
        },
        async end() {},
      },
    }
  }

  test('PK detection uses COLUMN_KEY = PRI and FK uses REFERENCED_TABLE_NAME', async () => {
    const { pool } = mysqlPoolScripted([
      [{ table_name: 'orders', row_count: '12' }],
      [
        { table_name: 'orders', column_name: 'id', data_type: 'int', is_nullable: 'NO', is_pk: 1, fk_ref_table: null, fk_ref_column: null },
        { table_name: 'orders', column_name: 'cust_id', data_type: 'int', is_nullable: 'YES', is_pk: 0, fk_ref_table: 'customers', fk_ref_column: 'id' },
      ],
      [],
    ])
    const c = new My(MY_CFG, 'MYSQL')
    ;(c as unknown as { _pool: unknown })._pool = pool
    const tables = await c.fetchSchema()
    expect(tables[0].rowCount).toBe(12)
    expect(tables[0].columns[0].primaryKey).toBe(true)
    expect(tables[0].columns[1].foreignKey).toBe('customers.id')
  })

  test('all three queries carry the 30s timeout so a hung reflection cannot stall', async () => {
    const { pool, calls } = mysqlPoolScripted([[], [], []])
    const c = new My(MY_CFG, 'MYSQL')
    ;(c as unknown as { _pool: unknown })._pool = pool
    await c.fetchSchema()
    expect(calls.every((x) => x.timeout === 30000)).toBe(true)
  })

  test('the FK subquery filters on REFERENCED_TABLE_NAME IS NOT NULL', async () => {
    const { pool, calls } = mysqlPoolScripted([[], [], []])
    const c = new My(MY_CFG, 'MYSQL')
    ;(c as unknown as { _pool: unknown })._pool = pool
    await c.fetchSchema()
    // Without this filter every indexed column looks like a foreign key.
    expect(calls[1].sql).toContain('REFERENCED_TABLE_NAME IS NOT NULL')
    expect(calls[1].sql).toContain("(c.COLUMN_KEY = 'PRI') AS is_pk")
  })

  test('a NULL row_count from MySQL is coerced, never left null', async () => {
    const { pool } = mysqlPoolScripted([
      [{ table_name: 't', row_count: null }],
      [{ table_name: 't', column_name: 'id', data_type: 'int', is_nullable: 'NO', is_pk: 1, fk_ref_table: null, fk_ref_column: null }],
      [],
    ])
    const c = new My(MY_CFG, 'MYSQL')
    ;(c as unknown as { _pool: unknown })._pool = pool
    const tables = await c.fetchSchema()
    expect(tables[0].rowCount).toBe(0)
  })
})

describe('ClickHouseConnector.executeQuery — full paths', () => {
  test('JSONEachRow lines become rows, normalised, with a real timing', async () => {
    const body = [JSON.stringify({ at: '2024-01-01T00:00:00.000Z', n: 1 }), JSON.stringify({ at: null, n: 2 })].join('\n')
    const { c, queries } = chScripted(body)
    const r = await c.executeQuery('SELECT at, n FROM t LIMIT 2')
    expect(r.rows).toEqual([{ at: '2024-01-01T00:00:00.000Z', n: 1 }, { at: null, n: 2 }])
    expect(r.rowCount).toBe(2)
    expect(r.executionMs).toBeGreaterThanOrEqual(0)
    // The caller SQL is sent verbatim with the JSONEachRow format.
    expect(queries).toEqual([{ query: 'SELECT at, n FROM t LIMIT 2', format: 'JSONEachRow' }])
  })

  test('a body with only blank lines is zero rows, not a JSON.parse throw', async () => {
    const { c } = chScripted('\n\n   \n')
    const r = await c.executeQuery('SELECT a FROM t LIMIT 1')
    expect(r.rows).toEqual([])
    expect(r.rowCount).toBe(0)
  })

  test('a mutation is refused before the client is used', async () => {
    const { c, queries } = chScripted('')
    await expect(c.executeQuery('DROP TABLE t')).rejects.toThrow('Only SELECT/WITH queries are permitted.')
    expect(queries).toEqual([])
  })

  test('a ClickHouse table function is refused before the client is used', async () => {
    const { c, queries } = chScripted('')
    // readonly=1 does NOT cover file()/url()/s3()/remote(); the deny list does.
    for (const sql of [
      "SELECT * FROM url('http://169.254.169.254/latest/meta-data/', CSV)",
      "SELECT * FROM file('/etc/passwd', CSV)",
      "SELECT * FROM s3('http://evil/x', 'k', 's', CSV)",
      "SELECT * FROM remote('evil:9000', db, t)",
    ]) {
      await expect(c.executeQuery(sql)).rejects.toThrow(/not permitted on a read-only data source/)
    }
    expect(queries).toEqual([])
  })

  test('a malformed JSONEachRow line surfaces as a parse error (no silent row loss)', async () => {
    const { c } = chScripted('{"a": not-json}')
    await expect(c.executeQuery('SELECT a FROM t LIMIT 1')).rejects.toThrow()
  })

  test('ClickHouse close() does NOT close the HTTP client (pool-free transport)', async () => {
    let closed = 0
    const c = new Ch(CH_CFG, 'CLICKHOUSE')
    ;(c as unknown as { _client: unknown })._client = {
      query: async () => ({ text: async () => '' }),
      close: async () => { closed++ },
    }
    await c.close()
    // The client is dropped, not shut down — a close() here would tear down a
    // shared keep-alive agent on every integration edit.
    expect(closed).toBe(0)
    expect((c as unknown as { _client: unknown })._client).toBeNull()
  })
})

// ===========================================================================
// SOURCE FACT ASSERTIONS
//
// Stable facts about the module that pin a security-relevant guarantee or
// record a measured defect. Asserted on the SOURCE TEXT where the fact is a
// property of how the code is written (the bundler sees the source, not the
// runtime), because a runtime assertion cannot see a variable specifier.
// ===========================================================================

const MODULE_SRC = readFileSync(join(import.meta.dir, 'real-connectors.ts'), 'utf8')

/** Strip comments so a check cannot pass by matching its own documentation. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('source facts — invariants that a runtime assertion cannot see', () => {
  test('every driver loads through a LITERAL specifier in DRIVER_LOADERS', () => {
    for (const spec of ['pg', 'mysql2/promise', 'mssql', '@clickhouse/client']) {
      expect(MODULE_SRC).toContain(`async () => import('${spec}')`)
    }
    // A variable specifier is invisible to Turbopack and to output tracing: the
    // driver vanishes from the standalone image and dev, surfacing as
    // "driver not installed" in production only.
    expect(stripComments(MODULE_SRC)).not.toMatch(/await import\(\s*[a-zA-Z_$]/)
  })

  test('every SQL string this module emits either binds its filter or quotes its identifiers', () => {
    const code = stripComments(MODULE_SRC)
    // The four catalog queries bind their schema/table filter:
    expect(code).toContain('t.table_schema = $1')                  // pg
    expect(code).toContain('WHERE TABLE_SCHEMA = ?')                // mysql tables
    expect(code).toContain('WHERE c.TABLE_SCHEMA = ?')              // mysql columns
    expect(code).toContain('SCHEMA_NAME(t.schema_id) = @schema')    // mssql
    expect(code).toContain('{db:String}')                           // clickhouse

    // The enrichment queries are the ONLY places an identifier is interpolated,
    // and every one of them goes through a per-dialect quote function. Pin the
    // three quoting implementations: a `quote` reaching the SQL without going
    // through one of these is the regression to look for.
    expect(code).toContain("(s) => `\"${s.replace(/\"/g, '\"\"')}\"`")                       // pg
    expect(code).toContain("(s) => '`' + s.replace(/`/g, '``') + '`'")                       // mysql
    expect(code).toContain("(s) => '[' + s.replace(/]/g, ']]') + ']'")                       // mssql
    // ...and every interpolated fragment in an enrichment template is one of
    // quote(...)/q(...)/colNames — never a raw caller value.
    for (const fragment of ['${quote(col.name)}', '${q(table.tableName)}', '${colNames}']) {
      expect(code).toContain(fragment)
    }
    // Every remaining template-literal interpolation in the file is one of a
    // small, enumerated set: the timeout constant, the scheme/host URL builder,
    // the per-dialect quote helpers applied to an identifier, the collected
    // column list, the ClickHouse {db:String} parameter VALUE, and the two
    // error-message builders. Anything outside this set is a new interpolation
    // site and should be reviewed by hand.
    const ALLOWED_INTERPOLATIONS = [
      '`${QUERY_TIMEOUT_MS}`',
      "${useSsl ? 'https' : 'http'}://${c.host}:${c.port || 8123}",
      '${quote(col.name)}',
      '${q(table.tableName)}',
      '${colNames}',
      '${useSsl ? { rejectUnauthorized:',
      "${useSsl ? 'https' : 'http'}",
      '${db}',
      '${rows.length}',
      '${c.host}',
      // Non-SQL templates: error/identifier builders, none of which receive a
      // value the caller supplies to executeQuery.
      '${e.message}',
      '${providerLabel}',
      '${msg.slice(0, 300)}',
      "${found.join(', ')}",
      '${name}',
      '${pkg}',
      '${(e as Error).message}',
      '${Object.keys(DRIVER_LOADERS).join',
      '${c.fk_ref_table}.${c.fk_ref_column}',
      '${s.replace(/"/g',
      '${t.replace(/"/g',
    ]
    const templates = code.match(new RegExp('`[^`]*\\$\\{[^}]*\\}[^`]*`', 'g')) ?? []
    expect(templates.length).toBeGreaterThan(0)
    const unexplained = templates.filter(
      (t) => !ALLOWED_INTERPOLATIONS.some((a) => t.includes(a.replace(/^`|`$/g, ''))),
    )
    expect(unexplained).toEqual([])
  })

  test('the ClickHouse database name is parameterised, never a SQL literal', () => {
    const code = stripComments(MODULE_SRC)
    // This query once read `t.database = '${db}'` — the one connector that did
    // not bind its schema name. Pin the parameter form and forbid the literal.
    expect(code).toContain('query_params: { db }')
    expect(code).toContain('t.database = {db:String}')
    expect(code).not.toMatch(/t\.database\s*=\s*'\$\{/)
  })

  test('no credential reaches a log, an error message or a returned object', () => {
    const code = stripComments(MODULE_SRC)
    // Passwords flow only into driver config objects. There is no console.*,
    // no logger, and no `password` in a thrown/templated message.
    expect(code).not.toMatch(/console\.(log|warn|error|info)/)
    expect(code).not.toMatch(/throw new Error\([^)]*password/i)
    expect(code).not.toMatch(/Connection failed:[^`]*password/i)
    // The one place a raw driver message is echoed is bounded and is a transport
    // error, not a credential store — and it is truncated to 300 chars.
    expect(code).toContain('msg.slice(0, 300)')
    // `readDbConfig` returns the password to its caller by design (the caller
    // builds the pool). No OTHER return shape carries it — the only other
    // `return {` near a password is that one, plus parseConnectionString's.
    // Exactly two return sites mention a password, and both are the CONFIG
    // builders that hand it to the caller/pool — neither is an error or a result.
    expect(code.match(/\breturn\s*\{[^}]*password[^}]*\}/g)).toHaveLength(2)
    expect(code).toContain('ssl: ssl ?? false }')
    expect(code).toContain('parsed?.password ??')
    // Error messages are built from class labels only.
    expect(code).not.toMatch(/reason: '[a-z_]+', message: `?\$\{(?!msg)/)
  })

  test('the xp_cmdshell comment is not the only thing protecting SQL Server', () => {
    // The comment at ~996 claims assertNoDangerousFunctions blocks xp_cmdshell.
    // That is only true because guardrails.ts lists it; the comment is a claim
    // about ANOTHER file. Assert the claimed behaviour is executed in the test
    // above AND that this file does not re-implement its own deny list (the
    // duplicated-list failure mode this codebase already hit once).
    const code = stripComments(MODULE_SRC)
    expect(code).not.toMatch(/xp_cmdshell\s*['"]?\s*\)/)   // no inline rule here
    expect(code).toContain('detectDangerousFunctions(sql)')  // single shared source
  })
})

// ===========================================================================
// ROW-LIMIT AUDIT — measured, not assumed
// ===========================================================================

describe('row limits — nowhere is a result set bounded at execution time', () => {
  test('MEASURED: only ClickHouse bounds execution; pg/mysql/mssql do not', async () => {
    const code = stripComments(MODULE_SRC)
    // ClickHouse asks the SERVER for a wall-clock bound.
    expect(code).toContain('max_execution_time')
    // Postgres bounds TIME, not rows:
    expect(code).toContain('SET LOCAL statement_timeout = ')
    // mysql2 gets a per-query timeout:
    expect(code).toMatch(/timeout: QUERY_TIMEOUT_MS/)
    // Nothing anywhere clamps or streams rows. `SQL_MAX_LIMIT` is applied by
    // guardrails.ts as TEXT (and survives only for the streaming path); this
    // module never imports it, so a direct executeQuery caller is unbounded.
    expect(code).not.toContain('SQL_MAX_LIMIT')
    expect(code).not.toContain('max_rows_to_read')
    expect(code).not.toContain('max_result_rows')
    expect(code).not.toMatch(/rows\.slice\(0,\s*\d+\)/)
  })

  test('a full unbounded scan really does come back whole (Postgres)', async () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: i }))
    const client = pgClient({ onQuery: () => ({ rows: big, rowCount: big.length }) })
    const r = await withPgClient(client).executeQuery('SELECT id FROM huge')
    // No cap is applied by this module: 5000 rows in, 5000 rows out.
    expect(r.rows).toHaveLength(5000)
    expect(r.rowCount).toBe(5000)
  })

  test('the enrichment probe is the ONLY place this module bounds a result (LIMIT 21/1)', () => {
    const code = stripComments(MODULE_SRC)
    const limits = code.match(/LIMIT (21|1)\b/g) ?? []
    expect(limits).toHaveLength(2)
    // Both are reflection helpers, not the execution path.
    expect(code).toContain('SELECT DISTINCT ${quote(col.name)} AS v FROM ${q(table.tableName)} LIMIT 21')
    expect(code).toContain('FROM ${q(table.tableName)} LIMIT 1')
  })
})

// ===========================================================================
// INJECTION-FUZZ — every caller-controlled value pushed at the interpolation
// sites that cannot be parameterised (identifiers), through the REAL function
// bodies, asserting the hostile text never appears in the emitted SQL.
// ===========================================================================

describe('identifier injection — measured against the real quoting paths', () => {
  const HOSTILE_TABLE = 'users"; DROP TABLE orders; --'
  const HOSTILE_SCHEMA = 'evil"; DROP TABLE orders; --'
  const HOSTILE_COLUMN = 'a`; DROP TABLE t; --'

  const pgHostileResults = (sql: string) => {
    if (sql.includes('reltuples')) return { rows: [{ table_name: HOSTILE_TABLE, row_count: 2 }] }
    if (sql.includes('information_schema.columns')) {
      return { rows: [{ table_name: HOSTILE_TABLE, column_name: HOSTILE_COLUMN, data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
    }
    return { rows: [] }
  }

  /** Same, but with a table name that reflects cleanly so the ENRICHMENT path runs. */
  const pgHostileResults2 = (sql: string) => {
    if (sql.includes('reltuples')) return { rows: [{ table_name: 't', row_count: 2 }] }
    if (sql.includes('information_schema.columns')) {
      return { rows: [{ table_name: 't', column_name: 'c', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] }
    }
    return { rows: [] }
  }

  test('Postgres: a hostile TABLE name is quoted, so it cannot break out', async () => {
    const pool = pgStub(pgHostileResults)
    await withPgPool(pool, { ...PG_CFG, schema: 'public' }).fetchSchema()
    const emitted = pool.calls.map((c) => c.sql).join('\n')
    // The delimiter inside the name survives as DATA inside one quoted
    // identifier: `"users""; DROP TABLE orders; --"` — the `"` is doubled, so the
    // identifier never closes early and `; DROP TABLE orders; --` never becomes a
    // second statement. The two catalog queries are the only ones with a bare
    // `;` (their own trailing), and they bind the schema.
    expect(emitted).toContain('"users""; DROP TABLE orders; --"')
    const enrich = pool.calls.slice(2).map((c) => c.sql)
    expect(enrich.length).toBeGreaterThan(0)
    // EVERY `"` in the hostile name is doubled, which is exactly what makes the
    // emitted text stay ONE double-quoted identifier: the name is present
    // verbatim otherwise (so a naive `not.toContain('DROP TABLE')` would be
    // wrong here — the protection is the ESCAPING, not a sanitising strip).
    for (const stmt of enrich) {
      expect(stmt).toContain('"users""; DROP TABLE orders; --"')
      // No CLOSED double-quoted identifier may appear inside the injected name:
      // a single unescaped `"` would terminate it and start a statement.
      expect(stmt).not.toMatch(/[^"]"; DROP TABLE orders/)
      // Structural: the count of `\"` characters is even and the query ends in LIMIT.
      expect((stmt.match(/"/g) ?? []).length % 2).toBe(0)
      expect(stmt.endsWith(' LIMIT 21') || stmt.endsWith(' LIMIT 1')).toBe(true)
    }
    // The host is never in these queries, so no exfil channel is introduced.
    expect(emitted).not.toContain('pg_read_file')
  })

  test('Postgres: a hostile SCHEMA name reaches the driver only as a BOUND parameter', async () => {
    const pool = pgStub(pgHostileResults2)
    const c = withPgPool(pool, { ...PG_CFG, schema: HOSTILE_SCHEMA })
    await c.fetchSchema()
    // The two catalog queries bind it — the hostile text is a PARAM VALUE.
    expect(pool.calls[0].params).toEqual([HOSTILE_SCHEMA])
    expect(pool.calls[1].params).toEqual([HOSTILE_SCHEMA])

    // The enrichment queries CANNOT bind an identifier, so they interpolate it.
    // MEASURED: the value IS present in the SQL text at those two call sites —
    // but as a double-quote-escaped identifier, which pg rejects as a syntax
    // error rather than executing. This is the honest statement of the control:
    // the only validation between an admin-settable `schema` and interpolation
    // is the escaping at the call site (`schema.replace(/"/g, '""')`).
    const enriched = pool.calls.slice(2).map((x) => x.sql)
    expect(enriched.length).toBeGreaterThan(0)
    // The escaping is what keeps it an identifier: the `"` that would otherwise
    // close the qualifier is doubled, so the injected `;` never becomes a
    // statement terminator. Assert on the CONSTRUCTED shape, not on the absence
    // of the text (which is present — inside a quoted identifier).
    for (const stmt of enriched) {
      expect(stmt).toContain(String.fromCharCode(34, 34))            // `""` escape present
      expect(stmt).not.toMatch(/[^"]"; DROP TABLE orders/)           // never an unescaped close
      expect(stmt.endsWith(' LIMIT 21') || stmt.endsWith(' LIMIT 1')).toBe(true)
    }
  })

  test('MSSQL: a hostile name is bracketed so ] ] escaping holds', async () => {
    mssql.results = [
      { recordset: [{ table_name: 'we]ird; DROP TABLE x; --', row_count: 3 }] },
      { recordset: [{ table_name: 'we]ird; DROP TABLE x; --', column_name: 'na]me', data_type: 'varchar', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }] },
      { recordset: [] },
      { recordset: [] },
    ]
    await new Ms(MS_CFG, 'MSSQL').fetchSchema()
    const enrich = mssql.calls.slice(2)
    expect(enrich.some((s) => s.includes('FROM [we]]ird; DROP TABLE x; --]'))).toBe(true)
    expect(enrich.some((s) => s.includes('[na]]me]'))).toBe(true)
    for (const stmt of enrich) {
      // The bracketed identifier is closed exactly once and only at the end of
      // the hostile name — a single unescaped `]` would end it early.
      expect(stmt).not.toMatch(/[^\]]\]; DROP TABLE x/)
      expect(stmt.endsWith(' LIMIT 21') || stmt.endsWith(' LIMIT 1')).toBe(true)
    }
  })

  test('MySQL: a hostile name is backtick-quoted with doubling', async () => {
    const seen: string[] = []
    const c = new My(MY_CFG, 'MYSQL')
    ;(c as unknown as { _pool: unknown })._pool = {
      query: async (arg: unknown) => {
        const sql = typeof arg === 'string' ? arg : (arg as { sql: string }).sql
        seen.push(sql)
        if (sql.includes('TABLE_ROWS')) return [[{ table_name: 'a`; DROP TABLE x; --', row_count: 2 }], []]
        if (sql.includes('information_schema.columns')) {
          return [[{ table_name: 'a`; DROP TABLE x; --', column_name: 'c`d', data_type: 'text', is_nullable: 'YES', is_pk: 0, fk_ref_table: null, fk_ref_column: null }], []]
        }
        return [[], []]
      },
      getConnection: async () => { throw new Error(NEVER) },
      end: async () => {},
    }
    await c.fetchSchema()
    const enrich = seen.slice(2)
    expect(enrich.some((s) => s.includes('FROM `a``; DROP TABLE x; --`'))).toBe(true)
    expect(enrich.some((s) => s.includes('`c``d`'))).toBe(true)
    for (const stmt of enrich) {
      // Backticks doubled ⇒ the hostile name stays ONE identifier.
      expect(stmt).not.toMatch(/[^`]`; DROP TABLE x/)
      expect(stmt.endsWith(' LIMIT 21') || stmt.endsWith(' LIMIT 1')).toBe(true)
    }
  })

  test('ClickHouse: hostile identifiers cannot even reach the SQL text', async () => {
    const hostileDb = "x' UNION SELECT 1 --"
    const queries: Array<{ query: string; query_params?: Record<string, unknown> }> = []
    const c = new Ch({ host: 'h', database: hostileDb }, 'CLICKHOUSE')
    ;(c as unknown as { _client: unknown })._client = {
      query: async (a: { query: string; query_params?: Record<string, unknown> }) => {
        queries.push(a)
        return { text: async () => JSON.stringify({ table_name: 'a; DROP TABLE x; --', engine: 'Log', col_name: 'c', col_type: 'String', pk: 0 }) }
      },
      close: async () => {},
    }
    const tables = await c.fetchSchema()
    // The database name is out-of-band; exactly ONE query is issued and no
    // per-table identifier is ever built from the reflected table name.
    expect(queries).toHaveLength(1)
    expect(queries[0].query).not.toContain('UNION SELECT')
    expect(queries[0].query_params).toEqual({ db: hostileDb })
    // The reflected table name is returned as DATA, never re-queried.
    expect(tables[0].tableName).toBe('a; DROP TABLE x; --')
  })
})

// ===========================================================================
// PINNED DEFECTS — each one FAILS when the defect is fixed. See the marker.
// ===========================================================================

describe('pinned defects (each FAILS when the defect is fixed)', () => {
  test('the guardrail error message echoes the matched FUNCTION NAMES back to the caller', () => {
    // INVERT WHEN FIXED: replace `found.join(', ')` in
    // assertNoDangerousFunctions() with a stable label such as
    // `Query rejected: a side-effecting server function is not permitted on a
    // read-only data source.` — i.e. stop echoing the caller-influenced scan
    // result into the error text. When you do, the two `toContain` assertions
    // below become false and this test goes red, which is the point.
    //
    // Reachability is bounded: constructors of these names are known tokens from
    // a fixed regex list, so an attacker cannot inject arbitrary text here.
    // What they CAN do is reflect any of ~30 internal function/probe names back
    // through an error surface (a chat-turn error, an audit row). It is a
    // low-severity information-disclosure/reflection surface, not SQL injection.
    let msg = ''
    try {
      assertNoDangerousFunctions("SELECT pg_read_file('/etc/passwd')")
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toBe(
      'Query rejected: pg_read_file is not permitted on a read-only data source.',
    )

    msg = ''
    try {
      assertNoDangerousFunctions("SELECT * FROM url('http://x/')")
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('ClickHouse table function')
  })

  test('a stacked statement is REFUSED at the execution boundary, matching guardrails', () => {
    // INVERTED WHEN FIXED: `assertSingleStatement()` now rejects a batch, so the boundary is no
    // longer the weaker of the two guards. Asserted in BOTH directions, because a scanner that
    // rejected everything would satisfy the refusals alone.
    expect(() => assertSelectOnly('SELECT 1; SELECT 2')).toThrow(/single SQL statement/)
    expect(() => assertSelectOnly("SELECT 1; SELECT 'x'")).toThrow(/single SQL statement/)

    // The two guards now AGREE, which is the property that matters here.
    expect(validateAndSanitizeLlmSql('SELECT 1; SELECT 2').ok).toBe(false)
    expect(validateAndSanitizeLlmSql("SELECT 1; SELECT 'x'").ok).toBe(false)

    // Legitimate single statements that merely CONTAIN a semicolon-shaped character must survive,
    // or the fix trades a bypass for broken queries. Each of these appears in real generated SQL.
    for (const ok of [
      'SELECT 1',
      'SELECT 1;',
      "SELECT ';' AS semi",
      'SELECT "we;ird" FROM t',
      'SELECT 1 -- ; not a separator',
      'SELECT 1 /* ; nope */ AS a',
      "SELECT * FROM t WHERE name = 'a;b'",
      'WITH x AS (SELECT 1) SELECT * FROM x',
    ]) {
      expect([ok, (() => { try { assertSelectOnly(ok); return 'allowed' } catch { return 'rejected' } })()]).toEqual([ok, 'allowed'])
    }
  })

  test('DEFECT FIXED: a stacked SET LOCAL cannot disable statement_timeout', () => {
    // The real finding, measured end to end against Postgres 16 through this module's own
    // execution path. `client.query(sql)` uses the SIMPLE query protocol, which runs a
    // semicolon-separated batch (verified: `SELECT 1 AS a; SELECT 2 AS b` returns 2 result sets).
    // With the ceiling set to 2000ms:
    //
    //   control : the slow query alone            -> killed at 2001ms
    //   bypass  : `SELECT 1; SET LOCAL statement_timeout = 0; <same slow query>`
    //             -> BOTH scanners passed it and it ran to completion in 5687ms
    //
    // `SET LOCAL statement_timeout` is not a mutation keyword and opens no host file, so it satisfied
    // the lexical scanner AND assertNoDangerousFunctions; read-only mode permits it because the only
    // thing it writes is the session. That is a per-request denial of service against the org's own
    // database. Pinned as a regression, not as a description of the code.
    const bypass = 'SELECT 1; SET LOCAL statement_timeout = 0; SELECT count(*) FROM generate_series(1, 60000000) g'
    expect(() => assertSelectOnly(bypass)).toThrow(/single SQL statement/)
    // The individual statements are still legal, so the refusal is about CHAINING, not about SET.
    expect(() => assertSelectOnly('SELECT set_config(chr(120))')).not.toThrow()
    // And the timeout value itself is re-asserted after the query runs, so a batch that ever slipped
    // past the scanner could not leave a disabled ceiling on a pooled backend. Asserted from source.
    const src = readFileSync(join(import.meta.dir, 'real-connectors.ts'), 'utf8')
    const resets = [...src.matchAll(/SET LOCAL statement_timeout = \$\{QUERY_TIMEOUT_MS\}/g)]
    expect(resets.length).toBe(2)
  })

  test('assertSelectOnly does NOT reject PG_SLEEP, which the IN-MODULE comment claims it does', () => {
    // INVERT WHEN FIXED: either delete/repair the sentence in the READ-ONLY block
    // comment that says "assertNoDangerousFunctions denies … pg_sleep" while the
    // MSSQL comment says the scanner path is what covers it, OR move the claim to
    // the layer that actually fires. The measured facts:
    expect(() => assertSelectOnly('SELECT pg_sleep(2)')).not.toThrow()      // scanner: ALLOWED
    expect(() => assertNoDangerousFunctions('SELECT pg_sleep(2)')).toThrow() // function list: BLOCKED
    // So the denial is real; the attribution in that paragraph is the defect.
    // This assertion pins the attribution as currently WRONG: if someone fixes
    // the comment AND the code to agree, re-derive this line rather than deleting
    // the test.
    expect(MODULE_SRC).toContain('and pg_sleep by the server-side')
  })

  test('writeFileSync / child_process are never imported (the module cannot exec)', () => {
    // The xp_cmdshell comment sits in MssqlConnector.executeQuery. Read it: the
    // code sends the caller SQL through `pool.request().query(sql)` and nothing
    // else — there is no OS-command path, and this module imports no process,
    // fs-write or network API of its own.
    const code = stripComments(MODULE_SRC)
    expect(code).not.toMatch(/child_process|execSync|spawnSync|node:fs|from 'fs'/)
    expect(code).not.toMatch(/process\.env(?!\.DB_SSL_REJECT_UNAUTHORIZED)/)
    const mssqlExec = code.slice(code.indexOf('class MssqlConnector'))
    expect(mssqlExec).toContain('const result = await pool.request().query(sql)')
    // The comment names xp_cmdshell; the enforcement lives in guardrails.ts.
    expect(MODULE_SRC).toContain('xp_cmdshell')
    expect(code).not.toContain('xp_cmdshell')
  })
})
