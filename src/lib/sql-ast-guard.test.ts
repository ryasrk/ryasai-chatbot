import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ansiQuotesToBackticks, checkSqlAst, type SqlAccessPolicy } from '@/lib/sql-ast-guard'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'

const pg = (sql: string, extra: Parameters<typeof checkSqlAst>[1] = {}) => checkSqlAst(sql, { provider: 'POSTGRESQL', ...extra })

function policy(entries: Record<string, string[] | null>): SqlAccessPolicy {
  return {
    tables: new Map(Object.entries(entries).map(([t, cols]) => [t, { allowedColumns: cols ? new Set(cols) : null }])),
  }
}

const SCHEMA = new Map<string, Set<string>>([
  ['employees', new Set(['id', 'name', 'dept_id', 'salary'])],
  ['departments', new Set(['id', 'name'])],
  ['orders', new Set(['id', 'customer_id', 'total', 'created_at'])],
])

describe('checkSqlAst — statement shape (fail-closed)', () => {
  test('a plain SELECT with CTE, join, subquery and casts passes', () => {
    const r = pg(
      "WITH t AS (SELECT customer_id, SUM(total) s FROM orders WHERE created_at >= CURRENT_DATE - INTERVAL '3 months' GROUP BY 1) " +
      'SELECT t.customer_id, t.s::numeric FROM t WHERE t.s > (SELECT avg(total) FROM orders) LIMIT 10',
    )
    expect(r).toEqual({ ok: true, checked: true, tables: ['orders'] })
  })

  test('an unparseable query is REJECTED, with a reason the repair loop can act on', () => {
    const r = pg('SELECT FROM WHERE (')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe('parse')
      expect(r.reason).toContain('one plain SELECT')
    }
  })

  test('two statements are rejected even when both are SELECT', () => {
    const r = pg('SELECT 1 FROM orders; SELECT 2 FROM orders')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('statement')
  })

  test.each([
    ['DELETE FROM orders'],
    ['UPDATE orders SET total = 0'],
    ['INSERT INTO orders (id) VALUES (1)'],
    ['DROP TABLE orders'],
  ])('a non-SELECT statement is rejected: %s', (sql) => {
    const r = pg(sql)
    expect(r.ok).toBe(false)
  })

  test('SELECT … INTO (table creation) is rejected', () => {
    const r = pg('SELECT id INTO copy_of_orders FROM orders')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('into')
  })

  test('FOR UPDATE is rejected (the parser does not accept it, so it fails closed)', () => {
    expect(pg('SELECT id FROM orders FOR UPDATE').ok).toBe(false)
  })
})

describe('checkSqlAst — functions and system catalogs', () => {
  test.each([
    ["SELECT pg_read_file('/etc/passwd')", 'pg_read_file'],
    ['SELECT pg_sleep(10) FROM orders', 'pg_sleep'],
    ["SELECT set_config('statement_timeout', '0', true)", 'set_config'],
    ["SELECT dblink('host=evil', 'select 1')", 'dblink'],
  ])('a side-effecting function is rejected as a NODE: %s', (sql, label) => {
    const r = pg(sql)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe('function')
      expect(r.detectedNodes).toContain(label)
    }
  })

  test('the same function name inside a string literal is data, not a call', () => {
    expect(pg("SELECT id FROM orders WHERE note = 'pg_read_file('").ok).toBe(true)
  })

  test.each([
    ['SELECT * FROM pg_catalog.pg_user'],
    ['SELECT usename FROM pg_user'],
    ['SELECT table_name FROM information_schema.tables'],
    ['SELECT id FROM orders WHERE id IN (SELECT oid FROM pg_class)'],
  ])('a system catalog is rejected, schema-qualified or not: %s', (sql) => {
    const r = pg(sql)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('system_schema')
  })

  test('MSSQL sys schema and MySQL system schemas are rejected in their dialects', () => {
    expect(checkSqlAst('SELECT name FROM sys.objects', { provider: 'MSSQL' }).ok).toBe(false)
    expect(checkSqlAst('SELECT user FROM mysql.user', { provider: 'MYSQL' }).ok).toBe(false)
  })

  test('dialect-specific syntax parses in its own dialect', () => {
    expect(checkSqlAst('SELECT TOP 10 [name], SUM(qty) AS q FROM dbo.order_items GROUP BY [name] ORDER BY q DESC', { provider: 'MSSQL' }).ok).toBe(true)
    expect(checkSqlAst('SELECT `name`, SUM(qty) FROM `order_items` GROUP BY `name` LIMIT 10', { provider: 'MYSQL' }).ok).toBe(true)
  })

  test('ClickHouse is not AST-checked (lexical layer + server readonly=1 apply)', () => {
    expect(checkSqlAst('SELECT count() FROM events FORMAT JSON', { provider: 'CLICKHOUSE' })).toEqual({ ok: true, checked: false, tables: [] })
  })
})

describe('checkSqlAst — per-role access policy', () => {
  const viewer = policy({ employees: ['id', 'name', 'dept_id'], departments: null })

  test('an allowed table and allowed columns pass', () => {
    const r = pg('SELECT e.name, d.name FROM employees e JOIN departments d ON d.id = e.dept_id LIMIT 10', { policy: viewer, schemaColumns: SCHEMA })
    expect(r.ok).toBe(true)
  })

  test('a table outside the policy is denied — including one reached only through a subquery', () => {
    const r = pg('SELECT name FROM employees WHERE id IN (SELECT customer_id FROM orders)', { policy: viewer, schemaColumns: SCHEMA })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe('access')
      expect(r.detectedNodes).toEqual(['table:orders'])
    }
  })

  test('a restricted column is denied in the SELECT list', () => {
    const r = pg('SELECT name, salary FROM employees', { policy: viewer, schemaColumns: SCHEMA })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detectedNodes).toEqual(['column:employees.salary'])
  })

  test('a restricted column is denied in WHERE too — filtering on it leaks it', () => {
    const r = pg('SELECT name FROM employees WHERE salary > 20000000', { policy: viewer, schemaColumns: SCHEMA })
    expect(r.ok).toBe(false)
  })

  test('a restricted column is denied inside an aggregate and through an alias', () => {
    expect(pg('SELECT avg(e.salary) FROM employees e', { policy: viewer, schemaColumns: SCHEMA }).ok).toBe(false)
  })

  test('a restricted column is denied inside a CTE body', () => {
    const r = pg('WITH s AS (SELECT salary FROM employees) SELECT * FROM s', { policy: viewer, schemaColumns: SCHEMA })
    expect(r.ok).toBe(false)
  })

  test('SELECT * on a column-restricted table is denied with a "name the columns" repair hint', () => {
    const r = pg('SELECT * FROM employees', { policy: viewer, schemaColumns: SCHEMA })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('instead of using *')
  })

  test('SELECT * on an unrestricted table and count(*) on a restricted one both pass', () => {
    expect(pg('SELECT * FROM departments', { policy: viewer, schemaColumns: SCHEMA }).ok).toBe(true)
    expect(pg('SELECT count(*) FROM employees', { policy: viewer, schemaColumns: SCHEMA }).ok).toBe(true)
  })

  test('a select-list alias reused in ORDER BY is not mistaken for a restricted column', () => {
    expect(pg('SELECT name AS n FROM employees ORDER BY n', { policy: viewer, schemaColumns: SCHEMA }).ok).toBe(true)
  })

  test('without reflected columns an unqualified column is attributed to EVERY table (stricter, never looser)', () => {
    const r = pg('SELECT n FROM employees', { policy: viewer })
    expect(r.ok).toBe(false)
  })

  test('table names compare case-insensitively', () => {
    expect(pg('SELECT NAME FROM Employees', { policy: viewer, schemaColumns: SCHEMA }).ok).toBe(true)
  })
})

describe('checkSqlAst — MySQL-family sessions run with ANSI_QUOTES', () => {
  // The connector sets ANSI_QUOTES, so on the server `"salary"` is the COLUMN. Before the guard rewrote double quotes,
  // the parser read these as string literals and both queries below passed with `salary` denied.
  const viewer = policy({ employees: ['id', 'name', 'dept_id'], departments: null })

  for (const provider of ['MYSQL', 'MARIADB']) {
    test(`${provider}: a double-quoted restricted column is denied in WHERE and ORDER BY`, () => {
      for (const sql of [
        'SELECT name FROM employees WHERE "salary" > 100',
        'SELECT name FROM employees ORDER BY "salary" DESC LIMIT 1',
        'SELECT "e"."name" FROM "employees" "e" WHERE "e"."salary" > 100',
      ]) {
        const r = checkSqlAst(sql, { provider, policy: viewer, schemaColumns: SCHEMA })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.detectedNodes).toEqual(['column:employees.salary'])
      }
    })

    test(`${provider}: double-quoted allowed names still pass, and single-quoted values stay values`, () => {
      const r = checkSqlAst(`SELECT "name" FROM "employees" WHERE "name" = 'Ann "salary"' LIMIT 5`, { provider, policy: viewer, schemaColumns: SCHEMA })
      expect(r.ok).toBe(true)
    })
  }

  test('PostgreSQL is not rewritten (double quotes are already identifiers there)', () => {
    expect(pg('SELECT name FROM employees WHERE "salary" > 100', { policy: viewer, schemaColumns: SCHEMA }).ok).toBe(false)
  })
})

describe('checkSqlAst — managed provider presets are checked through their protocol family', () => {
  // These ids reached the guard as-is and were not in its dialect map, so it skipped every check for them.
  const viewer = policy({ employees: ['id', 'name'] })
  for (const provider of ['SUPABASE', 'NEON', 'COCKROACHDB', 'PLANETSCALE', 'TIDB']) {
    test(`${provider}: the per-role policy is enforced`, () => {
      const r = checkSqlAst('SELECT salary FROM employees', { provider, policy: viewer, schemaColumns: SCHEMA })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.kind).toBe('access')
      expect(checkSqlAst('SELECT name FROM employees', { provider, policy: viewer, schemaColumns: SCHEMA }).ok).toBe(true)
    })
  }

  test('MySQL-family presets get the ANSI_QUOTES reading too', () => {
    const r = checkSqlAst('SELECT name FROM employees WHERE "salary" > 1', { provider: 'TIDB', policy: viewer, schemaColumns: SCHEMA })
    expect(r.ok).toBe(false)
  })

  test('ClickHouse and unknown ids stay unchecked (the parser has no ClickHouse dialect)', () => {
    expect(checkSqlAst('SELECT 1', { provider: 'CLICKHOUSE' })).toEqual({ ok: true, checked: false, tables: [] })
    expect(checkSqlAst('SELECT 1', { provider: 'SOMETHING_ELSE' })).toEqual({ ok: true, checked: false, tables: [] })
  })
})

describe('ansiQuotesToBackticks', () => {
  test('rewrites identifiers, escaping embedded quotes and backticks', () => {
    expect(ansiQuotesToBackticks('SELECT "a" FROM "t"')).toBe('SELECT `a` FROM `t`')
    expect(ansiQuotesToBackticks('SELECT "a""b", "c`d"')).toBe('SELECT `a"b`, `c``d`')
  })

  test('leaves strings, backticked names and comments untouched', () => {
    const sql = `SELECT \`x\` FROM t WHERE a = 'say "hi"' AND b = 'it''s' AND c = 'back\\'"slash' -- "c"\n/* "d" */ # "e"`
    expect(ansiQuotesToBackticks(sql)).toBe(sql)
  })

  test('an unterminated quote does not loop or throw', () => {
    expect(ansiQuotesToBackticks('SELECT "abc')).toBe('SELECT `abc`')
    expect(ansiQuotesToBackticks("SELECT 'abc")).toBe("SELECT 'abc")
  })
})

describe('validateAndSanitizeLlmSql with a provider runs the AST layer', () => {
  /*
   * MEASURED 2026-10-04: two queries the lexical scan let through. Postgres `READ ONLY` does not stop either —
   * `pg_read_file` is a read, and so is the activity view (which shows other sessions' SQL text).
   */
  test('a catalog reached through a quoted comma-join passes the lexical scan and is stopped by the parse', () => {
    const sql = 'SELECT name FROM orders o, "pg_stat_activity" s'
    expect(validateAndSanitizeLlmSql(sql).ok).toBe(true) // the lexical layer alone — the measured gap
    expect(validateAndSanitizeLlmSql(sql, { provider: 'POSTGRESQL' }).ok).toBe(false)
  })

  test('a QUOTED function name is caught by both layers (the lexical scan now unquotes identifiers)', () => {
    const sql = `SELECT "pg_read_file"('/etc/passwd')`
    expect(validateAndSanitizeLlmSql(sql).ok).toBe(false)
    expect(checkSqlAst(sql, { provider: 'POSTGRESQL' }).ok).toBe(false)
  })

  test('large-object reads are denied', () => {
    expect(validateAndSanitizeLlmSql('SELECT lo_get(16400) FROM orders').ok).toBe(false)
  })

  test('the query that runs is the model text with the lexical LIMIT clamp — never a re-serialised tree', () => {
    const r = validateAndSanitizeLlmSql('SELECT name FROM employees', { provider: 'POSTGRESQL' })
    expect(r.ok).toBe(true)
    expect(r.sanitized.replace(/;$/, '')).toBe('SELECT name FROM employees LIMIT 100')
  })
})

describe('regression: every benchmark gold query still passes the full guard', () => {
  // Measured before adopting the parser: 137/138 distinct real queries and 480/480 gold queries passed. The gold set is in the repo,
  // so it is pinned here; a parser upgrade that starts rejecting valid business SQL fails by name.
  const root = join(import.meta.dir, '../../benchmark')
  const gold: string[] = []
  for (const f of readdirSync(join(root, 'questions'))) {
    if (f.startsWith('clickhouse')) continue
    const text = readFileSync(join(root, 'questions', f), 'utf8')
    for (const m of text.matchAll(/groundTruthSql:\s*(['"`])([\s\S]*?)\1\s*,/g)) gold.push(m[2].replace(/\\n/g, ' '))
  }
  for (const r of JSON.parse(readFileSync(join(root, 'data/readiness-sql.json'), 'utf8')) as Array<{ referenceSQL: string }>) {
    gold.push(r.referenceSQL)
  }

  test('the corpus is not empty', () => {
    expect(gold.length).toBeGreaterThan(300)
  })

  test('no gold query is rejected by the AST layer', () => {
    const rejected = gold.filter((sql) => !checkSqlAst(sql, { provider: 'POSTGRESQL' }).ok)
    expect(rejected).toEqual([])
  })
})
