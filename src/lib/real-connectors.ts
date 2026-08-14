/**
 * Real database connectors — Postgres, MySQL, MSSQL.
 * Replaces the SqliteDemoConnector mapping for external DB integrations.
 *
 * Drivers are dynamically imported so the app boots without them; a clear
 * error is thrown only when a provider is actually used and its driver is
 * missing. Matches the cognee.ts graceful-degradation pattern.
 *
 * Each connector implements BaseDatabaseConnector:
 *   - testConnection()  → SELECT 1, return boolean
 *   - fetchSchema()     → information_schema reflection → ReflectedTable[]
 *   - executeQuery(sql) → run validated SQL (guardrails already ran)
 *   - close()           → drain connection pool (called by registry.drop)
 */
import type {
  BaseDatabaseConnector,
  QueryResult,
  QueryRow,
  ReflectedColumn,
  ReflectedTable,
} from './connectors'
import { getDbProviderPreset } from '@/lib/db-provider-presets'

// ponytail: 30s query timeout — matches the REST/LLM timeout convention (CLAUDE.md §6).
const QUERY_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Config + row helpers
// ---------------------------------------------------------------------------

interface DbConfig {
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
  if (!/^(postgres(ql)?|mysql(2)?):\/\//i.test(s)) return null
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
  if (/database .* does not exist|3d000|1049 unknown database|cannot open database/i.test(lower)) {
    return { reason: 'database_missing', message: 'The database name is wrong or the database does not exist on that server.' }
  }

  return {
    reason: 'unknown',
    message: `Connection failed: ${msg.slice(0, 300)}`,
  }
}

// ponytail: managed providers (Supabase/Neon/PlanetScale/TiDB/CockroachDB) default to
// TLS even though the UI never sends ssl:true — keeps plaintext credentials off the wire.
function resolveUseSsl(config: Record<string, unknown>, providerId?: string): boolean {
  const c = readDbConfig(config)
  if (c.ssl) return true
  const preset = providerId ? getDbProviderPreset(providerId) : undefined
  return preset?.sslByDefault === true
}

const MUTATION_KEYWORDS = new Set([
  'DELETE', 'UPDATE', 'INSERT', 'DROP', 'ALTER', 'TRUNCATE',
  'CREATE', 'GRANT', 'REVOKE', 'MERGE', 'REPLACE', 'CALL',
  'EXEC', 'EXECUTE', 'RENAME', 'ATTACH', 'DETACH', 'PRAGMA',
  'VACUUM', 'REINDEX', 'ANALYZE', 'LOCK', 'UNLOCK',
])

// ponytail: execution-boundary guard. Callers (tool-branches, stream-preparers, query
// route) already run full AST validation via guardrails.ts — this is belt-and-suspenders.
export function assertSelectOnly(sql: string): void {
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
    else if (typeof v === 'bigint') out[k] = Number(v)
    else if (Buffer.isBuffer(v)) out[k] = '0x' + v.toString('hex')
    else if (v && typeof v === 'object' && typeof (v as { toISOString?: unknown }).toISOString === 'function')
      out[k] = (v as { toISOString: () => string }).toISOString()
    else out[k] = v
  }
  return out
}

export async function loadDriver(name: string): Promise<Record<string, unknown>> {
  try {
    return (await import(name)) as Record<string, unknown>
  } catch (e) {
    const pkg = name.split('/')[0]
    throw new Error(
      `Database driver '${name}' is not installed. Run: bun add ${pkg}. Original error: ${(e as Error).message}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Detailed test helper — SELECT 1 with a classified error instead of boolean.
// ---------------------------------------------------------------------------

/** Anything that can run a one-shot SELECT 1 and be drained afterwards. */
interface PingablePool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (...args: any[]) => Promise<unknown>
  end?: () => Promise<unknown>
  close?: () => Promise<unknown>
}

/** Run SELECT 1 through a freshly built pool, classifying failures. */
async function detailedPing(
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

interface RawColumnRow {
  table_name: string
  column_name: string
  data_type: string
  is_nullable: string // 'YES' | 'NO'
  is_pk: boolean | number
  fk_ref_table: string | null
  fk_ref_column: string | null
}

interface RawTableRow {
  table_name: string
  row_count: number | string
}

function assembleSchema(cols: RawColumnRow[], tables: RawTableRow[]): ReflectedTable[] {
  const tableRowCount = new Map<string, number>()
  for (const t of tables) tableRowCount.set(t.table_name, Math.max(0, Number(t.row_count) || 0))

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
const ENRICH_QUERY_BUDGET = 150
const ENRICH_CONCURRENCY = 6

async function enrichSchema(
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
    const rc = table.rowCount ?? 0
    if (rc <= 0 || rc > 10000) continue
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

export class PostgresConnector implements BaseDatabaseConnector {
  readonly provider = 'POSTGRESQL'
  // ponytail: `any` for dynamically-imported pool — avoids type resolution
  // issues when the driver isn't installed. Public methods stay typed.
  private _pool: any = null
  constructor(
    private _config: Record<string, unknown>,
    private _providerId?: string,
  ) {}

  private async pool(): Promise<any> {
    if (!this._pool) {
      const pg = await loadDriver('pg')
      const c = readDbConfig(this._config)
      const useSsl = resolveUseSsl(this._config, this._providerId)
      // ponytail: TLS verification ON by default; opt-out via DB_SSL_REJECT_UNAUTHORIZED=0 for dev/self-signed.
      // A stored connectionString flows straight to pg — it carries its own sslmode.
      const explicitConnStr =
        typeof this._config.connectionString === 'string' && this._config.connectionString
          ? this._config.connectionString
          : undefined
      this._pool = new (pg.Pool as new (cfg: Record<string, unknown>) => unknown)({
        ...(explicitConnStr ? { connectionString: explicitConnStr } : {
          host: c.host,
          port: c.port || 5432,
          database: c.database,
          user: c.user,
          password: c.password,
        }),
        ssl: useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' } : undefined, // nosemgrep — verification enabled by default, opt-out only for dev
        query_timeout: QUERY_TIMEOUT_MS,
        connectionTimeoutMillis: QUERY_TIMEOUT_MS,
        idleTimeoutMillis: 30_000,
        max: 10,
      })
    }
    return this._pool
  }

  async testConnection(): Promise<boolean> {
    try {
      const pool = await this.pool()
      await pool.query('SELECT 1')
      return true
    } catch {
      return false
    }
  }

  /** SELECT 1 on a FRESH pool, with a classified diagnostic on failure. */
  async testConnectionDetailed(): Promise<DetailedTestResult> {
    return detailedPing(async () => {
      const pg = await loadDriver('pg')
      const c = readDbConfig(this._config)
      const useSsl = resolveUseSsl(this._config, this._providerId)
      const explicitConnStr =
        typeof this._config.connectionString === 'string' && this._config.connectionString
          ? this._config.connectionString
          : undefined
      return new (pg.Pool as new (cfg: Record<string, unknown>) => unknown)({
        ...(explicitConnStr ? { connectionString: explicitConnStr } : {
          host: c.host,
          port: c.port || 5432,
          database: c.database,
          user: c.user,
          password: c.password,
        }),
        ssl: useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' } : undefined,
        query_timeout: QUERY_TIMEOUT_MS,
        connectionTimeoutMillis: QUERY_TIMEOUT_MS,
        max: 1,
      }) as unknown as PingablePool
    }, this._providerId)
  }

  async fetchSchema(): Promise<ReflectedTable[]> {
    const pool = await this.pool()
    const schema = readDbConfig(this._config).schema ?? 'public'
    // ponytail: rowCount from pg_class.reltuples (catalog estimate) — avoids
    // expensive COUNT(*) on large tables. ANALYZE refreshes the estimate.
    // JOIN ON relname alone was WRONG: multi-schema databases (Supabase ships
    // auth./storage./extensions…) hold same-named tables across schemas, so
    // each information_schema row matched EVERY pg_class entry with that name —
    // duplicated tables and mixed-up counts. Resolve the namespace FIRST, then
    // match pg_class on (relname, relnamespace) so the join is 1:1.
    const tablesRes = await pool.query(
      `SELECT t.table_name,
              CASE WHEN c.reltuples IS NULL OR c.reltuples < 0 THEN 0 ELSE c.reltuples END AS row_count
       FROM information_schema.tables t
       LEFT JOIN pg_namespace n ON n.nspname = t.table_schema
       LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid
       WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'`,
      [schema],
    )
    const colsRes = await pool.query(
      `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
              pk.column_name IS NOT NULL AS is_pk,
              fk.ref_table AS fk_ref_table, fk.ref_column AS fk_ref_column
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
       ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
       LEFT JOIN (
         SELECT kcu.table_name, kcu.column_name,
                MAX(ccu.table_name) AS ref_table, MAX(ccu.column_name) AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
         GROUP BY kcu.table_name, kcu.column_name
       ) fk ON fk.table_name = c.table_name AND fk.column_name = c.column_name
       WHERE c.table_schema = $1
       ORDER BY c.table_name, c.ordinal_position`,
      [schema],
    )
    const tables = assembleSchema(
      (colsRes.rows as RawColumnRow[]) ?? [],
      (tablesRes.rows as RawTableRow[]) ?? [],
    )
    await enrichSchema(
      tables,
      async (sql) => (await pool.query(sql)).rows as QueryRow[],
      (s) => `"${s.replace(/"/g, '""')}"`,
      (t) => `"${schema.replace(/"/g, '""')}"."${t.replace(/"/g, '""')}"`,
    )
    return tables
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    assertSelectOnly(sql)
    const pool = await this.pool()
    const start = Date.now()
    const result = await pool.query(sql)
    const rows: QueryRow[] = (result.rows as QueryRow[]) ?? []
    return {
      rows: rows.map((r) => normaliseRow(r)),
      rowCount: result.rowCount ?? rows.length,
      executionMs: Date.now() - start,
    }
  }

  async close(): Promise<void> {
    if (this._pool) await this._pool.end()
    this._pool = null
  }
}

// ---------------------------------------------------------------------------
// MysqlConnector — uses mysql2/promise Pool
// ---------------------------------------------------------------------------

export class MysqlConnector implements BaseDatabaseConnector {
  readonly provider = 'MYSQL'
  private _pool: any = null
  constructor(
    private _config: Record<string, unknown>,
    private _providerId?: string,
  ) {}

  private async pool(): Promise<any> {
    if (!this._pool) {
      const mysql = await loadDriver('mysql2/promise')
      const c = readDbConfig(this._config)
      const useSsl = resolveUseSsl(this._config, this._providerId)
      this._pool = (mysql.createPool as (cfg: Record<string, unknown>) => unknown)({
        host: c.host,
        port: c.port || 3306,
        database: c.database,
        user: c.user,
        password: c.password,
        ssl: useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' } : undefined, // nosemgrep — verification enabled by default, opt-out only for dev
        connectionLimit: 10,
        connectTimeout: QUERY_TIMEOUT_MS,
        enableKeepAlive: true,
      })
    }
    return this._pool
  }

  async testConnection(): Promise<boolean> {
    try {
      const pool = await this.pool()
      await pool.query({ sql: 'SELECT 1', timeout: QUERY_TIMEOUT_MS })
      return true
    } catch {
      return false
    }
  }

  /** SELECT 1 on a FRESH pool, with a classified diagnostic on failure. */
  async testConnectionDetailed(): Promise<DetailedTestResult> {
    return detailedPing(async () => {
      const mysql = await loadDriver('mysql2/promise')
      const c = readDbConfig(this._config)
      const useSsl = resolveUseSsl(this._config, this._providerId)
      return (mysql.createPool as (cfg: Record<string, unknown>) => unknown)({
        host: c.host,
        port: c.port || 3306,
        database: c.database,
        user: c.user,
        password: c.password,
        ssl: useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' } : undefined, // nosemgrep — verification enabled by default, opt-out only for dev
        connectionLimit: 1,
        connectTimeout: QUERY_TIMEOUT_MS,
        enableKeepAlive: true,
      }) as unknown as PingablePool
    }, this._providerId)
  }

  async fetchSchema(): Promise<ReflectedTable[]> {
    const pool = await this.pool()
    const db = readDbConfig(this._config).database
    // ponytail: TABLE_ROWS is a catalog estimate for InnoDB — avoids COUNT(*).
    const [tablesRows] = await pool.query({
      sql: `SELECT TABLE_NAME AS table_name, COALESCE(TABLE_ROWS, 0) AS row_count
            FROM information_schema.tables
            WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
      values: [db],
      timeout: QUERY_TIMEOUT_MS,
    })
    // COLUMN_KEY = 'PRI' marks PK columns; REFERENCED_TABLE_NAME non-null marks FK.
    const [colsRows] = await pool.query({
      sql: `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name,
                   c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
                   (c.COLUMN_KEY = 'PRI') AS is_pk,
                   kcu.REFERENCED_TABLE_NAME AS fk_ref_table,
                   kcu.REFERENCED_COLUMN_NAME AS fk_ref_column
            FROM information_schema.columns c
            LEFT JOIN (
              SELECT TABLE_NAME, COLUMN_NAME,
                     MAX(REFERENCED_TABLE_NAME) AS REFERENCED_TABLE_NAME,
                     MAX(REFERENCED_COLUMN_NAME) AS REFERENCED_COLUMN_NAME
              FROM information_schema.key_column_usage
              WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
              GROUP BY TABLE_NAME, COLUMN_NAME
            ) kcu ON kcu.TABLE_NAME = c.TABLE_NAME AND kcu.COLUMN_NAME = c.COLUMN_NAME
            WHERE c.TABLE_SCHEMA = ?
            ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      values: [db, db],
      timeout: QUERY_TIMEOUT_MS,
    })
    const tables = assembleSchema(
      (colsRows as RawColumnRow[]) ?? [],
      (tablesRows as RawTableRow[]) ?? [],
    )
    await enrichSchema(
      tables,
      async (sql) => {
        const [rows] = await pool.query({ sql, timeout: QUERY_TIMEOUT_MS })
        return (rows as QueryRow[]) ?? []
      },
      (s) => '`' + s.replace(/`/g, '``') + '`',
    )
    return tables
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    assertSelectOnly(sql)
    const pool = await this.pool()
    const start = Date.now()
    const [rows] = await pool.query({ sql, timeout: QUERY_TIMEOUT_MS })
    const r: QueryRow[] = (rows as QueryRow[]) ?? []
    return {
      rows: r.map((row) => normaliseRow(row)),
      rowCount: r.length,
      executionMs: Date.now() - start,
    }
  }

  async close(): Promise<void> {
    if (this._pool) await this._pool.end()
    this._pool = null
  }
}

// ---------------------------------------------------------------------------
// MssqlConnector — uses mssql ConnectionPool
// ---------------------------------------------------------------------------

export class MssqlConnector implements BaseDatabaseConnector {
  readonly provider = 'MSSQL'
  private _pool: any = null
  constructor(
    private _config: Record<string, unknown>,
    private _providerId?: string,
  ) {}

  private async pool(): Promise<any> {
    if (!this._pool) {
      const mssql = await loadDriver('mssql')
      const c = readDbConfig(this._config)
      const useSsl = resolveUseSsl(this._config, this._providerId)
      // ponytail: server maps to host; requestTimeout covers all queries on this pool.
      const inst = new (mssql.ConnectionPool as unknown as new (cfg: Record<string, unknown>) => { connect(): Promise<unknown> })({
        server: c.host,
        port: c.port || 1433,
        database: c.database,
        user: c.user,
        password: c.password,
        connectionTimeout: QUERY_TIMEOUT_MS,
        requestTimeout: QUERY_TIMEOUT_MS,
        options: { encrypt: useSsl, trustServerCertificate: !useSsl },
        pool: { max: 10, idleTimeoutMillis: 30_000 },
      })
      await inst.connect()
      this._pool = inst
    }
    return this._pool
  }

  async testConnection(): Promise<boolean> {
    try {
      const pool = await this.pool()
      await pool.request().query('SELECT 1')
      return true
    } catch {
      return false
    }
  }

  /** SELECT 1 on a FRESH pool, with a classified diagnostic on failure. */
  async testConnectionDetailed(): Promise<DetailedTestResult> {
    try {
      const mssql = await loadDriver('mssql')
      const c = readDbConfig(this._config)
      const useSsl = resolveUseSsl(this._config, this._providerId)
      const inst = new (mssql.ConnectionPool as unknown as new (cfg: Record<string, unknown>) => {
        connect(): Promise<unknown>
        request(): { query: (sql: string) => Promise<unknown> }
        close(): Promise<unknown>
      })({
        server: c.host,
        port: c.port || 1433,
        database: c.database,
        user: c.user,
        password: c.password,
        connectionTimeout: QUERY_TIMEOUT_MS,
        requestTimeout: QUERY_TIMEOUT_MS,
        options: { encrypt: useSsl, trustServerCertificate: !useSsl },
        pool: { max: 1, idleTimeoutMillis: 5_000 },
      })
      await inst.connect()
      try {
        await inst.request().query('SELECT 1')
        return { ok: true, message: 'Connection successful.' }
      } finally {
        inst.close().catch(() => {})
      }
    } catch (e) {
      const d = describeConnectionError(e, this._providerId)
      return { ok: false, reason: d.reason, message: d.message }
    }
  }

  async fetchSchema(): Promise<ReflectedTable[]> {
    const pool = await this.pool()
    const schema = readDbConfig(this._config).schema ?? 'dbo'
    // ponytail: row_count from sys.partitions (catalog estimate) — avoids COUNT(*).
    const tablesRes = await pool.request()
      .input('schema', schema)
      .query(
        `SELECT t.name AS table_name, COALESCE(SUM(p.rows), 0) AS row_count
         FROM sys.tables t
         JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
         WHERE SCHEMA_NAME(t.schema_id) = @schema
         GROUP BY t.name`,
      )
    const colsRes = await pool.request()
      .input('schema', schema)
      .query(
        `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name,
                c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
                CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_pk,
                fk.ref_table AS fk_ref_table, fk.ref_column AS fk_ref_column
         FROM INFORMATION_SCHEMA.COLUMNS c
         LEFT JOIN (
           SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME
           FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
             ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
           WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = @schema
         ) pk ON pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
         LEFT JOIN (
           SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME,
                  MAX(ccu.TABLE_NAME) AS ref_table, MAX(ccu.COLUMN_NAME) AS ref_column
           FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
             ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
           JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
             ON rc.UNIQUE_CONSTRAINT_NAME = ccu.CONSTRAINT_NAME AND rc.UNIQUE_CONSTRAINT_SCHEMA = ccu.CONSTRAINT_SCHEMA
           WHERE kcu.TABLE_SCHEMA = @schema
           GROUP BY kcu.TABLE_NAME, kcu.COLUMN_NAME
         ) fk ON fk.TABLE_NAME = c.TABLE_NAME AND fk.COLUMN_NAME = c.COLUMN_NAME
         WHERE c.TABLE_SCHEMA = @schema
         ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      )
    const tables = assembleSchema(
      (colsRes.recordset as RawColumnRow[]) ?? [],
      (tablesRes.recordset as RawTableRow[]) ?? [],
    )
    await enrichSchema(
      tables,
      async (sql) => (await pool.request().query(sql)).recordset as QueryRow[],
      (s) => '[' + s.replace(/]/g, ']]') + ']',
    )
    return tables
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    assertSelectOnly(sql)
    const pool = await this.pool()
    const start = Date.now()
    const result = await pool.request().query(sql)
    const rows: QueryRow[] = (result.recordset as QueryRow[]) ?? []
    return {
      rows: rows.map((r) => normaliseRow(r)),
      rowCount: rows.length,
      executionMs: Date.now() - start,
    }
  }

  async close(): Promise<void> {
    if (this._pool) await this._pool.close()
    this._pool = null
  }
}

// ---------------------------------------------------------------------------
// ClickHouseConnector — uses @clickhouse/client
// ClickHouse is a columnar OLAP database. It uses HTTP (not TCP) and has
// a different SQL dialect (no LIMIT by default, uses LIMIT N instead).
// The guardrails already enforce SELECT-only + LIMIT 100, which is compatible.
// ---------------------------------------------------------------------------

export class ClickHouseConnector implements BaseDatabaseConnector {
  readonly provider = 'CLICKHOUSE'
  private _client: any = null
  constructor(
    private _config: Record<string, unknown>,
    private _providerId?: string,
  ) {}

  private async client(): Promise<any> {
    if (!this._client) {
      const ch = await loadDriver('@clickhouse/client')
      const c = readDbConfig(this._config)
      const useSsl = resolveUseSsl(this._config, this._providerId)
      const createClient = ch.createClient as (opts: Record<string, unknown>) => unknown
      this._client = createClient({
        url: `${useSsl ? 'https' : 'http'}://${c.host}:${c.port || 8123}`,
        database: c.database || 'default',
        username: c.user,
        password: c.password,
        // ponytail: no clickhouse_settings — some servers (play.clickhouse.com) are readonly
      })
    }
    return this._client
  }

  async testConnection(): Promise<boolean> {
    try {
      const cl = await this.client()
      const rs = await cl.query({ query: 'SELECT 1 AS ok', format: 'JSONEachRow' })
      const text = await rs.text()
      return text.includes('"ok"')
    } catch {
      return false
    }
  }

  /** SELECT 1 on a FRESH client, with a classified diagnostic on failure. */
  async testConnectionDetailed(): Promise<DetailedTestResult> {
    try {
      const ch = await loadDriver('@clickhouse/client')
      const c = readDbConfig(this._config)
      const useSsl = resolveUseSsl(this._config, this._providerId)
      const createClient = ch.createClient as (opts: Record<string, unknown>) => {
        query: (q: { query: string; format?: string }) => Promise<{ text: () => Promise<string> }>
        close: () => Promise<void>
      }
      const cl = createClient({
        url: `${useSsl ? 'https' : 'http'}://${c.host}:${c.port || 8123}`,
        database: c.database || 'default',
        username: c.user,
        password: c.password,
        request_timeout: QUERY_TIMEOUT_MS,
      })
      try {
        const rs = await cl.query({ query: 'SELECT 1 AS ok', format: 'JSONEachRow' })
        const text = await rs.text()
        if (!text.includes('"ok"')) {
          return { ok: false, reason: 'unknown', message: 'Server responded but not with a valid result.' }
        }
        return { ok: true, message: 'Connection successful.' }
      } finally {
        cl.close().catch(() => {})
      }
    } catch (e) {
      const d = describeConnectionError(e, this._providerId)
      return { ok: false, reason: d.reason, message: d.message }
    }
  }

  async fetchSchema(): Promise<ReflectedTable[]> {
    const cl = await this.client()
    const db = this.dbName()
    // ponytail: batch schema reflection — single query for all tables + columns.
    // The playground has a 100 queries/hour quota, so per-table queries would exhaust it fast.
    const rs = await cl.query({
      query: `SELECT t.name AS table_name, t.engine AS engine, c.name AS col_name, c.type AS col_type, c.position AS col_pos, c.is_in_primary_key AS pk FROM system.tables t LEFT JOIN system.columns c ON t.database = c.database AND t.name = c.table WHERE t.database = '${db}' AND t.engine NOT LIKE '%Materialized%' ORDER BY t.name, c.position FORMAT JSONEachRow`,
      format: 'JSONEachRow',
    })
    const text = await rs.text()
    const rows = text.trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l))

    // Group rows by table
    const tableMap = new Map<string, { engine: string; columns: any[] }>()
    for (const r of rows) {
      if (!tableMap.has(r.table_name)) {
        tableMap.set(r.table_name, { engine: r.engine, columns: [] })
      }
      if (r.col_name) {
        tableMap.get(r.table_name)!.columns.push({
          name: r.col_name,
          type: r.col_type,
          primaryKey: r.pk === 1,
          notNull: !String(r.col_type).includes('Nullable'),
        })
      }
    }

    const result: ReflectedTable[] = []
    for (const [tableName, info] of tableMap) {
      result.push({
        tableName,
        columns: info.columns,
        rowCount: 0, // ponytail: skip count() on 70 tables — too many queries for playground quota
      })
    }
    return result
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    assertSelectOnly(sql)
    const cl = await this.client()
    const start = Date.now()
    const rs = await cl.query({ query: sql, format: 'JSONEachRow' })
    const text = await rs.text()
    const exec = Date.now() - start
    const rows: QueryRow[] = text.trim().split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
    return { rows: rows.map((r) => normaliseRow(r)), rowCount: rows.length, executionMs: exec }
  }

  async close(): Promise<void> {
    this._client = null
  }

  private dbName(): string {
    return String((this._config as Record<string, unknown>).database ?? 'default')
  }
}
