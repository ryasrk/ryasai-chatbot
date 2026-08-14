import { describe, expect, test } from 'bun:test'
import {
  parseConnectionString,
  describeConnectionError,
  readDbConfig,
} from './real-connectors'

// ---------------------------------------------------------------------------
// parseConnectionString — Supabase/Neon/PlanetScale hand users URLs, not fields
// ---------------------------------------------------------------------------

describe('parseConnectionString', () => {
  test('parses a full postgres URL', () => {
    const c = parseConnectionString('postgresql://user:pass@db.supabase.co:5432/postgres?sslmode=require')
    expect(c).not.toBeNull()
    expect(c!.host).toBe('db.supabase.co')
    expect(c!.port).toBe(5432)
    expect(c!.database).toBe('postgres')
    expect(c!.user).toBe('user')
    expect(c!.password).toBe('pass')
    expect(c!.ssl).toBe(true)
  })

  test('parses a Supabase pooler URL with dotted username', () => {
    const c = parseConnectionString('postgresql://postgres.abcdefghij:pass@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres')
    expect(c!.user).toBe('postgres.abcdefghij')
    expect(c!.host).toBe('aws-0-ap-southeast-1.pooler.supabase.com')
    expect(c!.port).toBe(6543)
    expect(c!.database).toBe('postgres')
  })

  test('parses postgres:// scheme alias', () => {
    const c = parseConnectionString('postgres://u:p@h:5433/mydb')
    expect(c!.host).toBe('h')
    expect(c!.port).toBe(5433)
    expect(c!.database).toBe('mydb')
  })

  test('parses mysql:// scheme', () => {
    const c = parseConnectionString('mysql://root:pw@127.0.0.1:3306/sakila')
    expect(c!.host).toBe('127.0.0.1')
    expect(c!.port).toBe(3306)
    expect(c!.database).toBe('sakila')
    expect(c!.user).toBe('root')
  })

  test('url-encodes special characters in user and password', () => {
    const c = parseConnectionString('postgresql://us%40r:p%40ss@h:5432/d')
    expect(c!.user).toBe('us@r')
    expect(c!.password).toBe('p@ss')
  })

  test('picks up ?schema= param (Supabase/Prisma convention)', () => {
    const c = parseConnectionString('postgresql://u:p@h:5432/db?schema=myschema')
    expect(c!.schema).toBe('myschema')
  })

  test('ssl default absent without sslmode', () => {
    const c = parseConnectionString('postgresql://u:p@h:5432/d')
    expect(c!.ssl).toBeUndefined()
  })

  test('returns null for non-URL input', () => {
    expect(parseConnectionString('')).toBeNull()
    expect(parseConnectionString('not a url')).toBeNull()
    expect(parseConnectionString('mongodb://h/d')).toBeNull()
    expect(parseConnectionString('http://h/d')).toBeNull()
  })

  test('returns null for malformed URL', () => {
    expect(parseConnectionString('postgresql://[::1')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// readDbConfig — connection string takes precedence, fields still work
// ---------------------------------------------------------------------------

describe('readDbConfig with connectionString', () => {
  test('connectionString wins over individual fields', () => {
    const c = readDbConfig({
      connectionString: 'postgresql://cu:cp@chost:6432/cdb',
      host: 'wrong',
      port: 1,
      username: 'wrong',
      password: 'wrong',
      database_name: 'wrong',
    })
    expect(c.host).toBe('chost')
    expect(c.port).toBe(6432)
    expect(c.user).toBe('cu')
    expect(c.password).toBe('cp')
    expect(c.database).toBe('cdb')
  })

  test('empty connectionString falls back to fields', () => {
    const c = readDbConfig({
      connectionString: '',
      host: 'h',
      port: 5432,
      username: 'u',
      password: 'p',
      database_name: 'd',
    })
    expect(c.host).toBe('h')
    expect(c.user).toBe('u')
    expect(c.database).toBe('d')
  })

  test('non-string connectionString is ignored', () => {
    const c = readDbConfig({
      connectionString: 123,
      host: 'h',
      port: 1,
      database: 'd',
      user: 'u',
      password: 'p',
    })
    expect(c.host).toBe('h')
  })

  test('legacy field-based config still parses identically', () => {
    const c = readDbConfig({ host: 'h', port: 5432, username: 'u', password: 'p', database_name: 'd' })
    expect(c).toEqual({ host: 'h', port: 5432, user: 'u', password: 'p', database: 'd', schema: undefined, ssl: false })
  })
})

// ---------------------------------------------------------------------------
// describeConnectionError — the diagnostic mapper replacing the opaque string
// ---------------------------------------------------------------------------

describe('describeConnectionError', () => {
  test('classifies postgres password auth failure (28P01)', () => {
    const d = describeConnectionError(
      new Error('password authentication failed for user "postgres"'),
    )
    expect(d.reason).toBe('auth')
    expect(d.message).toMatch(/Authentication failed/i)
  })

  test('classifies Supabase pooler auth failure with pooler-specific hint', () => {
    const d = describeConnectionError(
      new Error('password authentication failed for user "postgres.abc"'),
      'SUPABASE',
    )
    expect(d.reason).toBe('auth')
    expect(d.message).toMatch(/FULL username/i)
    expect(d.message).toMatch(/postgres\.project-ref/i)
  })

  test('classifies MySQL access denied (1045)', () => {
    const d = describeConnectionError(
      new Error("ER_ACCESS_DENIED_ERROR: Access denied for user 'root'@'localhost' (using password: YES)"),
    )
    expect(d.reason).toBe('auth')
  })

  test('classifies MSSQL login failed (18456)', () => {
    const d = describeConnectionError(new Error('Login failed for user \'sa\'. (code 18456)'))
    expect(d.reason).toBe('auth')
  })

  test('classifies self-signed certificate rejection', () => {
    const d = describeConnectionError(
      new Error('self signed certificate in certificate chain'),
    )
    expect(d.reason).toBe('ssl')
    expect(d.message).toMatch(/TLS\/SSL/i)
  })

  test('classifies "the server does not support SSL" (managed DB without TLS)', () => {
    const d = describeConnectionError(new Error('The server does not support SSL connections'))
    expect(d.reason).toBe('ssl')
  })

  test('classifies DNS failure (ENOTFOUND)', () => {
    const d = describeConnectionError(
      new Error('getaddrinfo ENOTFOUND db.xxyyzz.supabase.co'),
    )
    expect(d.reason).toBe('dns')
    expect(d.message).toMatch(/Host not found/i)
  })

  test('classifies timeout (firewall / no IP allow-list)', () => {
    const d = describeConnectionError(
      new Error('connection timeout: connect ETIMEDOUT 1.2.3.4:5432'),
    )
    expect(d.reason).toBe('timeout')
    expect(d.message).toMatch(/timed out/i)
    expect(d.message).toMatch(/allow-list/i)
  })

  test('classifies connection refused (wrong port)', () => {
    const d = describeConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:5433'))
    expect(d.reason).toBe('refused')
    expect(d.message).toMatch(/refused/i)
  })

  test('classifies database does not exist (3D000)', () => {
    const d = describeConnectionError(new Error('database "nosuchdb" does not exist (code 3D000)'))
    expect(d.reason).toBe('database_missing')
  })

  test('classifies missing driver', () => {
    const d = describeConnectionError(
      new Error("Database driver 'mssql' is not installed. Run: bun add mssql"),
    )
    expect(d.reason).toBe('driver_missing')
  })

  test('unknown errors keep their (truncated) message', () => {
    const long = 'x'.repeat(500)
    const d = describeConnectionError(new Error(long))
    expect(d.reason).toBe('unknown')
    expect(d.message.length).toBeLessThanOrEqual(300 + 'Connection failed: '.length)
  })

  test('non-Error values are stringified safely', () => {
    const d = describeConnectionError(42)
    expect(d.reason).toBe('unknown')
    expect(d.message).toContain('42')
  })
})
