/**
 * Injection SHAPES — regression guard for the fingerprint/tautology corpus.
 *
 * INCIDENT (2026-09, found by trial/fleet with 518 live cases): the guardrail
 * blocked mutations and side-effecting functions but ALLOWED every classic
 * injection shape, because each of them is a syntactically valid SELECT with no
 * mutation keyword and no known dangerous function:
 *
 *   SELECT * FROM users WHERE name = union select
 *   SELECT * FROM users WHERE name = or 1=1
 *   SELECT * FROM users WHERE name = and 1=1
 *   SELECT * FROM users WHERE name = or '1'='1'
 *   SELECT * FROM users WHERE name = 0x27 or 1=1
 *   SELECT * FROM users WHERE name = char(39)or 1=1
 *   SELECT * FROM users WHERE name = concat(0x44,0x52)
 *   SELECT @@version / database() / schema() / user() / pg_version()
 *
 * The same corpus also found a test in `security-prompt-injection.test.ts`
 * whose NAME said "guardrail catches it" while its BODY asserted
 * `expect(result.ok).toBe(true)` for a UNION-exfiltration payload — a guard that
 * encoded the defect it claimed to catch.
 *
 * Every case below is machine-checked; none required a live database.
 */
import { describe, expect, test } from 'bun:test'
import { validateAndSanitizeLlmSql, detectDangerousFunctions } from './guardrails'

const blocked = (sql: string) => validateAndSanitizeLlmSql(sql).ok === false

describe('injection shapes: tautologies', () => {
  const cases = [
    'SELECT * FROM users WHERE name = or 1=1',
    "SELECT * FROM users WHERE name = or '1'='1'",
    'SELECT * FROM users WHERE name = and 1=1',
    'SELECT * FROM users WHERE id = 0x27 or 1=1',
    'SELECT * FROM users WHERE id = char(39)or 1=1',
    'SELECT * FROM users WHERE x = concat(0x44,0x52)',
    'SELECT * FROM users WHERE a = 1 OR 1=1 --',
    'SELECT * FROM users WHERE a = 1 AND 2=2',
  ]
  for (const sql of cases) {
    test(`BLOCKED: ${sql}`, () => {
      expect(blocked(sql), `must not pass: ${sql}`).toBe(true)
    })
  }
})

describe('injection shapes: union-based extraction', () => {
  const cases = [
    'SELECT name FROM users UNION SELECT password FROM users',
    'SELECT name FROM users union all select password from users',
    'SELECT a FROM t UNION SELECT b FROM t WHERE 1=1',
  ]
  for (const sql of cases) {
    test(`BLOCKED: ${sql}`, () => {
      expect(blocked(sql), `must not pass: ${sql}`).toBe(true)
    })
  }
})

describe('injection shapes: fingerprint probes', () => {
  const cases = [
    'SELECT @@version',
    'SELECT @@datadir',
    'SELECT @@hostname',
    'SELECT version()',
    'SELECT pg_version()',
    'SELECT database()',
    'SELECT schema()',
    'SELECT user()',
    'SELECT current_user',
    'SELECT session_user',
    'SELECT pg_postmaster_start_time()',
    'SELECT inet_server_addr()',
    'SELECT inet_server_port()',
  ]
  for (const sql of cases) {
    test(`BLOCKED: ${sql}`, () => {
      expect(blocked(sql), `must not pass: ${sql}`).toBe(true)
    })
  }
})

describe('injection shapes: blind + stacked', () => {
  const cases = [
    'SELECT * FROM t WHERE name = waitfor delay',
    'SELECT updatexml(1,concat(0x7e),1)',
    'SELECT extractvalue(1,concat(0x7e))',
    'SELECT if(1=1,sleep(5),0)',
    'SELECT * FROM t WHERE a = 1; DROP TABLE users',
    'SELECT * FROM t WHERE a = 1; DELETE FROM users',
  ]
  for (const sql of cases) {
    test(`BLOCKED: ${sql}`, () => {
      expect(blocked(sql), `must not pass: ${sql}`).toBe(true)
    })
  }
})

describe('the fix must not over-block legitimate SQL', () => {
  // Over-blocking is a functional bug: it breaks real analyst questions while
  // looking like strong security. Each case here is plausible business SQL.
  const allowed = [
    // A COLUMN named version/user/database is not a probe.
    'SELECT version FROM releases',
    'SELECT user_id, name FROM users',
    'SELECT database_name FROM configs',
    // Probe function used as ONE column among others is a normal column list.
    'SELECT now(), version()',
    'SELECT count(*), version() FROM users',
    // Ordinary aggregates/functions.
    'SELECT count(*) FROM users',
    'SELECT lower(name) FROM users',
    'SELECT concat(first_name, last_name) FROM users',
    'SELECT substring(name, 1, 3) FROM users',
    'SELECT date_trunc(\'month\', created_at) FROM orders GROUP BY 1',
    // Literals that merely LOOK like attack strings are data, not clauses.
    "SELECT * FROM t WHERE note = 'union select'",
    "SELECT * FROM t WHERE note = 'or 1=1'",
    "SELECT * FROM t WHERE note = 'pg_read_file('",
    'SELECT * FROM t WHERE a = 1 AND b = 2',
    'SELECT * FROM t WHERE status = \'paid\'',
    'SELECT chr FROM characters',
    'SELECT * FROM char_table',
  ]
  for (const sql of allowed) {
    test(`ALLOWED: ${sql}`, () => {
      const r = validateAndSanitizeLlmSql(sql)
      expect(r.ok, `false positive on: ${sql} (${r.reason ?? ''})`).toBe(true)
    })
  }
})

describe('schema enumeration stays blocked', () => {
  // information_schema / pg_catalog are already rejected as system-table probes.
  // This is intentionally in the BLOCKED group, not the allowed one: a business
  // analyst never needs to enumerate the DB's own catalog.
  for (const sql of [
    'SELECT * FROM information_schema.tables',
    'SELECT * FROM pg_catalog.pg_shadow',
    'SELECT schema_name FROM information_schema.schemata',
  ]) {
    test(`BLOCKED: ${sql}`, () => {
      expect(blocked(sql)).toBe(true)
    })
  }
})

describe('detectDangerousFunctions shares one scan', () => {
  test('reports a label for each real attack shape', () => {
    expect(detectDangerousFunctions('SELECT * FROM users WHERE x = or 1=1').length).toBeGreaterThan(0)
    expect(detectDangerousFunctions('SELECT @@version').length).toBeGreaterThan(0)
    expect(detectDangerousFunctions('SELECT pg_read_file(\'/etc/passwd\')').length).toBeGreaterThan(0)
  })

  test('string literals are not scanned as clauses', () => {
    // maskStringLiterals must hide literal CONTENT, otherwise any document
    // mentioning "union select" would be blocked when echoed into SQL.
    expect(detectDangerousFunctions("SELECT 'union select' AS note")).toEqual([])
    expect(detectDangerousFunctions("SELECT 'or 1=1' AS note")).toEqual([])
  })
})
