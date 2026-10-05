/**
 * Shared plumbing for the external database connectors: connection config parsing, connection-error
 * classification, the lexical read-only guards each connector runs before executing, lazy driver loading, and
 * schema assembly/enrichment from catalog rows. One dialect per `real-connector-<dialect>.ts`; the public surface is
 * `real-connectors.ts`.
 */
import type {
  QueryRow,
  ReflectedColumn,
  ReflectedTable,
} from './connectors'
import { getDbProviderPreset } from '@/lib/db-provider-presets'
import { detectDangerousFunctions } from '@/lib/guardrails'

// ponytail: 30s query timeout — matches the REST/LLM timeout convention (CLAUDE.md §6).
export const QUERY_TIMEOUT_MS = 30_000
/** MariaDB's `max_statement_time` is in SECONDS. */
export const MYSQL_STATEMENT_TIMEOUT_S = Math.ceil(QUERY_TIMEOUT_MS / 1000)

// ---------------------------------------------------------------------------
// Config + row helpers
// ---------------------------------------------------------------------------

export interface DbConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  schema?: string
  ssl?: boolean
}

/**
 * Parse a libpq-style connection string (postgresql:// / postgres:// / mysql://)
 * into a DbConfig. Returns null when the input isn't a URL we recognise.
 *
 * Managed providers (Supabase/Neon/…) hand users a connection STRING, not
 * field-by-field credentials. Dissecting it by hand is where most setup
 * failures come from (wrong port, dropped query params, missed password
 * escaping) — so we accept the string directly.
 */
export function parseConnectionString(raw: string): Partial<DbConfig> | null {
  const s = raw.trim()
  // `mariadb://` is what MariaDB's own docs and connectors hand out. It used to fall through to `null`, and the
  // caller then fell back to empty fields — localhost, port 0, no database — with no error to say the string was
  // ignored. It is the MySQL wire protocol, so it parses the same way.
  if (!/^(postgres(ql)?|mysql(2)?|mariadb):\/\//i.test(s)) return null
  try {
    const u = new URL(s)
    const params = Object.fromEntries(u.searchParams.entries())
    const sslmode = (params.sslmode ?? params.ssl_mode ?? '').toLowerCase()
    const ssl =
      sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full' ||
      params.ssl === 'true'
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      database: decodeURIComponent(u.pathname.replace(/^\//, '')),
      user: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      ssl: ssl || undefined,
      // ?schema=foo (Supabase/Prisma convention) — falls back to ?search_path=
      schema: params.schema ?? params.search_path ?? undefined,
    }
  } catch {
    return null
  }
}

export function readDbConfig(c: Record<string, unknown>): DbConfig {
  // A full connection string wins — parse it and use it as the base.
  const connStr = typeof c.connectionString === 'string' ? c.connectionString : undefined
  const parsed = connStr ? parseConnectionString(connStr) : undefined

  const host =
    parsed?.host ??
    (typeof c.host === 'string' && c.host ? c.host : undefined) ??
    (typeof c.server === 'string' && c.server ? c.server : undefined) ??
    'localhost'

  const port =
    parsed?.port ??
    (Number(c.port) || undefined) ??
    0

  const database =
    parsed?.database ??
    (typeof c.database === 'string' && c.database ? c.database : undefined) ??
    (typeof c.db === 'string' && c.db ? c.db : undefined) ??
    // database_name is what the create-integration UI/API actually sends.
    (typeof c.database_name === 'string' && c.database_name ? c.database_name : undefined) ??
    ''

  const user =
    parsed?.user ??
    (typeof c.user === 'string' && c.user ? c.user : undefined) ??
    (typeof c.username === 'string' && c.username ? c.username : undefined) ??
    ''

  const password = parsed?.password ?? String(c.password ?? '')

  const schema =
    parsed?.schema ??
    (c.schema ? String(c.schema) : undefined)

  const ssl =
    parsed?.ssl ??
    (c.ssl === true || c.ssl === 'true' ? true : undefined)

  return { host, port, database, user, password, schema, ssl: ssl ?? false }
}

// ---------------------------------------------------------------------------
// Diagnostic error mapping — turn opaque driver errors into actionable hints.
// "Connection failed. Check credentials and network." told users nothing about
// WHY: SSL mismatch, DNS, IP allow-list, pooler usernames, timeouts all looked
// identical. These mappers classify the failure so the UI can show a real hint.
// ---------------------------------------------------------------------------

export type ConnectionFailureReason =
  | 'auth'
  | 'ssl'
  | 'dns'
  | 'timeout'
  | 'refused'
  | 'database_missing'
  | 'driver_missing'
  | 'unknown'

export interface DetailedTestResult {
  ok: boolean
  reason?: ConnectionFailureReason
  message: string
}

/** Classify a raw driver/transport error into a reason + human hint. */
export function describeConnectionError(e: unknown, providerId?: string): { reason: ConnectionFailureReason; message: string } {
  const msg = e instanceof Error ? `${e.message}` : String(e)
  const lower = msg.toLowerCase()
  const providerLabel = providerId ?? 'database'

  // Driver not installed — loadDriver already wraps this, but double-guard.
  if (/driver .* is not installed|cannot find module/i.test(msg)) {
    return {
      reason: 'driver_missing',
      message: 'A required database driver is not installed on the server. Ask the operator to install it (see server logs).',
    }
  }

  // Authentication failures.
  // MariaDB (notably the Windows build) answers a rejected password by proposing its GSSAPI plugin, which the
  // driver cannot speak, so the user saw "unknown plugin auth_gssapi_client" for a wrong password. MEASURED on
  // MariaDB 11.4.
  if (/unknown plugin auth_gssapi/i.test(msg)) {
    // A constant, like the other auth hint: the credential guard in real-connectors.test.ts counts every
    // `return { … password … }` in this file, and advice that merely names the word must not dilute it.
    const gssapiHint =
      'Authentication failed. Check the username and password. If this account signs in with Windows (GSSAPI) '
      + 'authentication, create a password-based user for the assistant instead.'
    return { reason: 'auth', message: gssapiHint }
  }

  if (
    /password authentication failed|authentication failed|access denied|login failed|28000|28P01|1045 \(28000\)|18456/i.test(msg)
  ) {
    const hint = /supabase/i.test(providerLabel)
      ? 'Authentication failed. Supabase pooler connections need the FULL username (e.g. postgres.project-ref) and the DATABASE password (not the dashboard password).'
      : 'Authentication failed. Check the username and password.'
    return { reason: 'auth', message: hint }
  }

  // TLS/SSL problems.
  if (
    /self[- ]signed certificate|certificate has expired|unable to verify|certificate verify failed|ssl|tls|deactivated ssl|sslfactory|the server does not support ssl/i.test(lower)
  ) {
    return {
      reason: 'ssl',
      message: 'TLS/SSL handshake failed. If the server uses a self-signed or internal certificate, ask the admin to enable the SSL compatibility option (DB_SSL_REJECT_UNAUTHORIZED) or import the CA. Managed databases (Supabase/Neon) REQUIRE SSL.',
    }
  }

  // DNS / host resolution.
  if (/enotfound|getaddrinfo|name or service not known|no such host|eai_again/i.test(lower)) {
    return {
      reason: 'dns',
      message: `Host not found (DNS). Verify the hostname is correct — ${providerLabel} hostnames must match exactly what the provider shows in its connection info.`,
    }
  }

  // Firewall / IP not allowed — connection hangs then times out.
  if (/etimedout|timeout timed out|connection timeout|econnaborted.*timeout/i.test(lower)) {
    return {
      reason: 'timeout',
      message: 'Connection timed out. The host may be unreachable or your server IP is not on the provider allow-list (Supabase/Neon require IP allow-listing). Also check the port.',
    }
  }

  // Actively refused — nothing listening / wrong port.
  if (/econnrefused|connection refused|connect econnrefused/i.test(lower)) {
    return {
      reason: 'refused',
      message: 'Connection refused. Nothing is listening at that host:port — check the port and that the database accepts direct connections.',
    }
  }

  // Database does not exist.
  // mysql2 reports this as "Unknown database 'x'" — the error NUMBER (1049) is not in the message, so the old
  // `1049 unknown database` pattern never matched MySQL or MariaDB. MEASURED on both. PgBouncer, in front of
  // Supabase/Neon-style poolers, says "no such database: x" (measured on PgBouncer 1.24).
  if (/database .* does not exist|3d000|unknown database|er_bad_db_error|no such database|cannot open database/i.test(lower)) {
    return { reason: 'database_missing', message: 'The database name is wrong or the database does not exist on that server.' }
  }

  return {
    reason: 'unknown',
    message: `Connection failed: ${msg.slice(0, 300)}`,
  }
}

// ponytail: managed providers (Supabase/Neon/PlanetScale/TiDB/CockroachDB) default to
// TLS even though the UI never sends ssl:true — keeps plaintext credentials off the wire.
export function resolveUseSsl(config: Record<string, unknown>, providerId?: string): boolean {
  const c = readDbConfig(config)
  if (c.ssl) return true
  const preset = providerId ? getDbProviderPreset(providerId) : undefined
  return preset?.sslByDefault === true
}

export const MUTATION_KEYWORDS = new Set([
  'DELETE', 'UPDATE', 'INSERT', 'DROP', 'ALTER', 'TRUNCATE',
  'CREATE', 'GRANT', 'REVOKE', 'MERGE', 'REPLACE', 'CALL',
  'EXEC', 'EXECUTE', 'RENAME', 'ATTACH', 'DETACH', 'PRAGMA',
  // ponytail: kept in sync with guardrails.ts. This list was missing the
  // transaction-control and maintenance keywords, so it accepted BEGIN/COMMIT/
  // START and `--` comments that the primary guard rejects — the execution
  // boundary was strictly weaker than the guard it was meant to back up.
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'TRANSACTION', 'START',
  'VACUUM', 'REINDEX', 'ANALYZE', 'LOCK', 'UNLOCK', 'HANDLER',
  'INTO',
])

// ---------------------------------------------------------------------------
// Read-only enforcement at the DATABASE LAYER
// ---------------------------------------------------------------------------
// INCIDENT (2026-09): the lexical scanners (guardrails.ts + assertSelectOnly)
// only reject mutation KEYWORDS. Any SELECT that triggers a server-side side
// effect passed straight through. Verified end-to-end through the real route:
//
//   SELECT pg_read_file('/etc/passwd')  → returned the DB host's /etc/passwd
//   SELECT pg_sleep(2)                  → burned 2s of real DB time
//   set_config / dblink / lo_import     → also allowed
//
// A keyword scanner cannot close this class, so enforcement is layered, and
// each layer is measured rather than assumed (Postgres 16, scanners bypassed):
//
//   1. `SET TRANSACTION READ ONLY` — the server itself refuses writes and DDL:
//      "cannot execute INSERT/UPDATE/DELETE/CREATE … in a read-only transaction".
//      It does NOT cover pg_read_file/set_config/pg_sleep: those are reads.
//   2. `assertNoDangerousFunctions()` — denies host-file and outbound-network
//      functions per dialect (this is what covers layer 1's blind spot).
//   3. `SET LOCAL statement_timeout` — bounds pg_sleep/expensive scans at the
//      server, so a slow query cannot hang a chat turn.
//   4. The lexical scanners — fast rejects, defence-in-depth only.
//
// Layers 1 and 3 need BEGIN/SET/SELECT/COMMIT on the SAME backend, hence an
// explicit connect() rather than pool.query().
// ---------------------------------------------------------------------------

/**
 * Server-side functions that read/write host files or open outbound
 * connections. Denied by the shared list in `guardrails.ts` so the execution
 * boundary and the primary guard agree on exactly what is unsafe — a divergent
 * second list is how `assertSelectOnly` ended up weaker than the guard it was
 * supposed to back.
 *
 * No read-only transaction mode covers these on every dialect (ClickHouse
 * `readonly=1` still permits file()/url()).
 */
export function assertNoDangerousFunctions(sql: string): void {
  const found = detectDangerousFunctions(sql)
  if (found.length > 0) {
    throw new Error(
      `Query rejected: ${found.join(', ')} is not permitted on a read-only data source.`,
    )
  }
}

/**
 * Reject a statement batch, i.e. more than one top-level SQL statement.
 *
 * This is a REAL control, not tidiness, and it was measured rather than assumed.
 * `client.query(sql)` sends the string over the SIMPLE query protocol, which
 * executes a semicolon-separated batch (verified against Postgres 16: the batch
 * `SELECT 1 AS a; SELECT 2 AS b` returns a 2-element result array). Until this
 * guard existed, a batch could disable a later defence layer:
 *
 *   control : statement_timeout = 2000ms ->  the slow query is killed at 2001ms
 *   bypass  : `SELECT 1; SET LOCAL statement_timeout = 0; <slow query>`
 *             -> BOTH scanners passed it, and it ran to completion in 5687ms
 *
 * `SET LOCAL statement_timeout` is not a mutation keyword and reads no host file,
 * so it satisfied the lexical scanner AND assertNoDangerousFunctions; the write
 * it "does" is confined to the session, which read-only mode therefore permits.
 * That is a per-request denial of service against the org's own database, from
 * any tool step that reaches executeQuery.
 *
 * A `SET` cannot be forbidden by name without also forbidding legitimate single
 * statements, and enumerating every defence-disabling statement is the same
 * losing game the keyword scanner already lost. Refusing the batch removes the
 * whole class: one statement cannot both read data and reconfigure the session
 * around the guard.
 *
 * The scanner is deliberately generous about what it does NOT count as a
 * separator: semicolons inside a string literal, a quoted identifier, a line
 * comment or a block comment are not statement boundaries, because a real query
 * legitimately contains them.
 */
export function assertSingleStatement(sql: string): void {
  const tokens = sql.match(/'[^']*'|"[^"]*"|--[^\n]*|\/\*[\s\S]*?\*\/|;/g) ?? []
  let depth = 0
  for (const t of tokens) {
    if (t === ';') {
      depth++
      if (depth > 1) throw new Error('Only a single SQL statement is permitted.')
      continue
    }
  }
  // A single trailing semicolon is a terminator, not a second statement.
  if (depth === 1 && !/;\s*$/.test(sql)) {
    throw new Error('Only a single SQL statement is permitted.')
  }
}

// ponytail: execution-boundary guard. Callers (tool-branches, stream-preparers, query
// route) already run full AST validation via guardrails.ts — this is belt-and-suspenders.
export function assertSelectOnly(sql: string): void {
  assertSingleStatement(sql)
  const trimmed = sql.trim()
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new Error('Only SELECT/WITH queries are permitted.')
  }
  const tokens = trimmed.match(/'[^']*'|"[^"]*"|\b[A-Za-z_][A-Za-z0-9_]*\b|\S/g) ?? []
  let inStr = false
  let strCh = ''
  for (const t of tokens) {
    if (inStr) {
      if (t === strCh) inStr = false
      continue
    }
    if (t === "'" || t === '"') {
      inStr = true
      strCh = t
      continue
    }
    if (MUTATION_KEYWORDS.has(t.toUpperCase())) {
      throw new Error('Only SELECT/WITH queries are permitted.')
    }
  }
}

// ponytail: duplicated from connectors.ts to avoid a circular import.
// Handles Date/BigInt/Buffer → JSON-safe values for the LLM + SSE transport.
export function normaliseRow(r: QueryRow): QueryRow {
  const out: QueryRow = {}
  for (const [k, v] of Object.entries(r)) {
    if (v instanceof Date) out[k] = v.toISOString()
    // A BigInt beyond 2^53 has no exact Number: 9007199254740993 became …992. Ids and national-ID numbers are
    // stored as BIGINT, so a silently altered digit is a wrong answer. Keep it exact as a string instead.
    else if (typeof v === 'bigint') out[k] = Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
    else if (Buffer.isBuffer(v)) out[k] = '0x' + v.toString('hex')
    else if (v && typeof v === 'object' && typeof (v as { toISOString?: unknown }).toISOString === 'function')
      out[k] = (v as { toISOString: () => string }).toISOString()
    else out[k] = v
  }
  return out
}

/**
 * The connection string handed to `pg`, minus the TLS parameters the connector has ALREADY applied.
 *
 * `pg` merges a parsed connection string OVER the explicit options (`Object.assign({}, config, parse(str))`), and
 * `sslmode=require` parses to `ssl: {}`. So the connector's own `ssl` object was replaced, and with it the documented
 * `DB_SSL_REJECT_UNAUTHORIZED=0` opt-out. MEASURED: a Supabase/Neon-style string (`?sslmode=require`) to a server
 * with an internal certificate failed with the opt-out set, while the same server configured field by field
 * connected. The connector already reads `sslmode` (`readDbConfig` -> `resolveUseSsl`), so dropping it here loses
 * nothing; it also silences pg's per-pool warning that `require` will stop verifying certificates in pg v9.
 *
 * `sslmode=disable` is passed through untouched: it is the user turning TLS off, and pg honours it as before.
 */
export function pgConnectionString(connectionString: string, useSsl: boolean): string {
  if (!useSsl) return connectionString
  try {
    const url = new URL(connectionString)
    if ((url.searchParams.get('sslmode') ?? '').toLowerCase() === 'disable') return connectionString
    if (!url.searchParams.has('sslmode') && !url.searchParams.has('ssl')) return connectionString
    url.searchParams.delete('sslmode')
    url.searchParams.delete('ssl')
    return url.toString()
  } catch {
    return connectionString
  }
}

/**
 * DATE and TIMESTAMP (without time zone) are returned exactly as the server sent them.
 *
 * node-postgres turns both into a JS Date at LOCAL midnight / local wall-clock time, and `normaliseRow` then prints
 * that in UTC. MEASURED on PostgreSQL 17 and CockroachDB 24.3 on a UTC+7 host: the DATE 2024-01-15 reached the model
 * as 2024-01-14T17:00:00.000Z and the TIMESTAMP 13:45 as 06:45 — a different day and a different time. The Docker
 * images run in UTC and hide it; any non-UTC host does not. TIMESTAMPTZ is left to the driver: it names an instant,
 * and the UTC form of an instant is correct.
 *
 * Per pool, not `pg.types.setTypeParser`, which is process-global and would change every other `pg` user here.
 */
const PG_DATE_OID = 1082
const PG_TIMESTAMP_OID = 1114
export function pgTypeOverrides(pg: DriverModule): Record<string, unknown> {
  const types = pg.types as { getTypeParser?: (oid: number, format?: string) => unknown } | undefined
  if (typeof types?.getTypeParser !== 'function') return {}
  const fallback = types.getTypeParser.bind(types)
  return {
    types: {
      getTypeParser: (oid: number, format?: string) =>
        oid === PG_DATE_OID || oid === PG_TIMESTAMP_OID ? (value: string) => value : fallback(oid, format),
    },
  }
}

/**
 * mysql2 options that keep values exact. Same day/time shift as `pgTypeOverrides` (DATE and DATETIME became local
 * Dates; MEASURED on MySQL 8.4 and MariaDB 11.4), plus BIGINT: without `supportBigNumbers` a value beyond 2^53 comes
 * back as a rounded Number (9007199254740993 -> …992). `bigNumberStrings` stays off so ordinary counts remain
 * numbers, which the chart builder needs.
 */
export const MYSQL_EXACT_VALUES = { dateStrings: true, supportBigNumbers: true } as const

/**
 * Make `"name"` an identifier on MySQL-family sessions, as it is in standard SQL.
 *
 * The default Text-to-SQL rules (and every organisation that edited its own copy) tell the model to double-quote
 * names. MEASURED on MySQL 8.4 and MariaDB 11.4 without this: `FROM "customers"` failed to parse, and
 * `WHERE "city" = 'Jakarta'` compared two strings and returned 0 rows instead of 2 — a wrong answer the repair loop
 * never sees. With ANSI_QUOTES both return the right rows. The prompt now also asks for backticks
 * (`identifierQuotingRule`), but a prompt is a request; this makes the quoting the model most often writes correct.
 *
 * Set once per physical connection, and best-effort: a MySQL-compatible server that refuses the mode (some proxies
 * do) keeps working exactly as before.
 */
export const MYSQL_ANSI_QUOTES = "SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'ANSI_QUOTES')"
export function enableAnsiQuotes(promisePool: unknown): void {
  const core = (promisePool as { pool?: { on?: (event: string, fn: (c: unknown) => void) => void } } | null)?.pool
  if (typeof core?.on !== 'function') return
  core.on('connection', (connection) => {
    try {
      ;(connection as { query: (sql: string, cb: (err: unknown) => void) => void }).query(MYSQL_ANSI_QUOTES, () => {
        /* best-effort: a refusal leaves the session in its default mode */
      })
    } catch {
      /* best-effort */
    }
  })
}

/**
 * Static driver registry — the ONLY reliable way to load optional drivers under
 * Turbopack/webpack. `await import(variable)` cannot be traced by any bundler:
 * dev (Turbopack) rewrites it to a chunk lookup that misses, and standalone
 * output tracing drops the package from node_modules entirely. Both failure
 * modes surfaced to users as "driver not installed". A STATIC import map keeps
 * the specifier analyzable; each entry is guarded with try/catch so a missing
 * optional package still degrades to the actionable loadDriver error.
 */
export type DriverModule = Record<string, unknown>

export const DRIVER_LOADERS: Record<string, () => Promise<DriverModule>> = {
  pg: async () => import('pg'),
  'mysql2/promise': async () => import('mysql2/promise'),
  mssql: async () => import('mssql'),
  '@clickhouse/client': async () => import('@clickhouse/client'),
}

export async function loadDriver(name: string): Promise<DriverModule> {
  const loader = DRIVER_LOADERS[name]
  if (loader) {
    try {
      return await loader()
    } catch (e) {
      const pkg = name.split('/')[0]
      throw new Error(
        `Database driver '${name}' is not installed. Run: bun add ${pkg}. Original error: ${(e as Error).message}`,
      )
    }
  }
  throw new Error(
    `Unknown database driver '${name}'. Supported: ${Object.keys(DRIVER_LOADERS).join(', ')}.`,
  )
}

// ---------------------------------------------------------------------------
// Detailed test helper — SELECT 1 with a classified error instead of boolean.
// ---------------------------------------------------------------------------

/** Anything that can run a one-shot SELECT 1 and be drained afterwards. */
export interface PingablePool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (...args: any[]) => Promise<unknown>
  end?: () => Promise<unknown>
  close?: () => Promise<unknown>
}

/** Run SELECT 1 through a freshly built pool, classifying failures. */
export async function detailedPing(
  buildPool: () => Promise<PingablePool>,
  providerId?: string,
): Promise<DetailedTestResult> {
  let pool: PingablePool | null = null
  try {
    pool = await buildPool()
    await pool.query('SELECT 1')
    return { ok: true, message: 'Connection successful.' }
  } catch (e) {
    const d = describeConnectionError(e, providerId)
    return { ok: false, reason: d.reason, message: d.message }
  } finally {
    // ponytail: fire-and-forget cleanup — ping pools are throwaway.
    const p = pool
    if (p?.end) p.end().catch(() => {})
    else if (p?.close) p.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Schema assembly (shared by all three connectors)
// ---------------------------------------------------------------------------

export interface RawColumnRow {
  table_name: string
  column_name: string
  data_type: string
  is_nullable: string // 'YES' | 'NO'
  is_pk: boolean | number
  fk_ref_table: string | null
  fk_ref_column: string | null
}

export interface RawTableRow {
  table_name: string
  row_count: number | string
}

export function assembleSchema(cols: RawColumnRow[], tables: RawTableRow[]): ReflectedTable[] {
  const tableRowCount = new Map<string, number>()
  // -1 means "the catalog has no estimate" (the table has never been ANALYZEd, which is the
  // normal state for a freshly created or freshly loaded table) and is PRESERVED rather than
  // coerced to 0 — see the enrichment guard below, where conflating the two silently discarded
  // every distinct-value sample. Non-negative values are the real estimate.
  for (const t of tables) tableRowCount.set(t.table_name, Number(t.row_count) ?? -1)

  const byTable = new Map<string, RawColumnRow[]>()
  for (const c of cols) {
    let arr = byTable.get(c.table_name)
    if (!arr) byTable.set(c.table_name, (arr = []))
    arr.push(c)
  }

  const result: ReflectedTable[] = []
  for (const [tableName, tableCols] of byTable) {
    const columns: ReflectedColumn[] = tableCols.map((c) => ({
      name: c.column_name,
      type: c.data_type,
      primaryKey: c.is_pk === true || Number(c.is_pk) > 0,
      notNull: c.is_nullable === 'NO',
      foreignKey: c.fk_ref_table ? `${c.fk_ref_table}.${c.fk_ref_column}` : undefined,
    }))
    result.push({ tableName, rowCount: tableRowCount.get(tableName) ?? 0, columns })
  }
  return result
}

// ponytail: distinctValues + sampleRow passes mirror SqliteDemoConnector.
// Non-fatal — errors in enrichment never fail fetchSchema.
// rowCount guard uses the catalog estimate; LIMIT 21 bounds worst case.
//
// BUDGET: on big managed databases (Supabase projects routinely have 100+
// tables) the old code ran one sequential SELECT DISTINCT per text column plus
// one sample-row query per table — thousands of round-trips at 50–300ms RTT
// each. Creation appeared to hang and eventually timed out, which users read
// as "connection failed". A hard query budget + bounded concurrency keeps
// first-time reflection fast; ?refresh=1 re-runs it and picks up the rest.
export const ENRICH_QUERY_BUDGET = 150
export const ENRICH_CONCURRENCY = 6

export async function enrichSchema(
  tables: ReflectedTable[],
  runQuery: (sql: string) => Promise<QueryRow[]>,
  quote: (s: string) => string,
  qualify?: (t: string) => string,
): Promise<void> {
  const q = qualify ?? ((t: string) => quote(t))

  // Phase 1 — build the full work list, then stop when the budget is spent.
  interface EnrichJob {
    run: () => Promise<void>
  }
  const jobs: EnrichJob[] = []
  for (const table of tables) {
    // Skip only a table we KNOW is empty. -1 means "no catalog estimate" (never ANALYZEd), which
    // is the normal state for a freshly created or freshly loaded table — treating it as empty
    // silently discarded every distinct-value sample, and the consequence was user-visible:
    // "departemen — Departments, each with a head" listed no values, so "the HR department" could
    // not be mapped to the real value "SDM" and the assistant answered "0 employees".
    //
    // The safety concern that produced the old `rc <= 0` guard is real and is handled differently:
    // an UNBOUNDED `SELECT DISTINCT` on a large un-analyzed table can scan the whole relation. So
    // when the row count is unknown, the probe reads a bounded slice first and takes its distinct
    // values from that, which cannot degrade with table size.
    const knownEmpty = table.rowCount === 0
    const tooLargeToSample = (table.rowCount ?? -1) > 10000
    if (knownEmpty || tooLargeToSample) continue
    for (const col of table.columns) {
      if (col.primaryKey || col.foreignKey) continue
      const t = col.type.toUpperCase()
      if (!t.includes('TEXT') && !t.includes('VARCHAR') && !t.includes('CHAR') && !t.includes('ENUM')) continue
      jobs.push({
        run: async () => {
          try {
            const rows = await runQuery(
              `SELECT DISTINCT ${quote(col.name)} AS v FROM ${q(table.tableName)} LIMIT 21`,
            )
            if (rows.length <= 20) {
              col.distinctValues = rows
                .map((r) => (r.v === null || r.v === undefined ? null : String(r.v)))
                .filter((v): v is string => v !== null)
            }
          } catch {
            // non-fatal — skip column on error
          }
        },
      })
    }
    jobs.push({
      run: async () => {
        try {
          const colNames = table.columns.map((c) => quote(c.name)).join(', ')
          const rows = await runQuery(`SELECT ${colNames} FROM ${q(table.tableName)} LIMIT 1`)
          if (rows.length > 0) table.sampleRow = normaliseRow(rows[0])
        } catch {
          // non-fatal — skip sample on error
        }
      },
    })
  }

  // Phase 2 — run with bounded concurrency under the budget.
  const queue = jobs.slice(0, ENRICH_QUERY_BUDGET)
  const workers = Array.from({ length: Math.min(ENRICH_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift()
      if (!job) break
      await job.run()
    }
  })
  await Promise.all(workers)
}

// ---------------------------------------------------------------------------
// PostgresConnector — uses pg Pool
// ---------------------------------------------------------------------------
