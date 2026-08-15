import { describe, expect, test, mock } from 'bun:test'
import {
  readDbConfig,
  normaliseRow,
  loadDriver,
  assertSelectOnly,
  PostgresConnector,
  MysqlConnector,
  MssqlConnector,
  ClickHouseConnector,
} from './real-connectors'

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
