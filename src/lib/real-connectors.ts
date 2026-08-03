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

export function readDbConfig(c: Record<string, unknown>): DbConfig {
  return {
    host: String(c.host ?? c.server ?? 'localhost'),
    port: Number(c.port ?? 0) || 0,
    database: String(c.database ?? c.db ?? ''),
    user: String(c.user ?? c.username ?? ''),
    password: String(c.password ?? ''),
    schema: c.schema ? String(c.schema) : undefined,
    ssl: c.ssl === true || c.ssl === 'true',
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
async function enrichSchema(
  tables: ReflectedTable[],
  runQuery: (sql: string) => Promise<QueryRow[]>,
  quote: (s: string) => string,
  qualify?: (t: string) => string,
): Promise<void> {
  const q = qualify ?? ((t: string) => quote(t))
  for (const table of tables) {
    const rc = table.rowCount ?? 0
    if (rc <= 0 || rc > 10000) continue
    for (const col of table.columns) {
      if (col.primaryKey || col.foreignKey) continue
      const t = col.type.toUpperCase()
      if (!t.includes('TEXT') && !t.includes('VARCHAR') && !t.includes('CHAR') && !t.includes('ENUM')) continue
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
    }
    try {
      const colNames = table.columns.map((c) => quote(c.name)).join(', ')
      const rows = await runQuery(`SELECT ${colNames} FROM ${q(table.tableName)} LIMIT 1`)
      if (rows.length > 0) table.sampleRow = normaliseRow(rows[0])
    } catch {
      // non-fatal — skip sample on error
    }
  }
}

// ---------------------------------------------------------------------------
// PostgresConnector — uses pg Pool
// ---------------------------------------------------------------------------

export class PostgresConnector implements BaseDatabaseConnector {
  readonly provider = 'POSTGRESQL'
  // ponytail: `any` for dynamically-imported pool — avoids type resolution
  // issues when the driver isn't installed. Public methods stay typed.
  private _pool: any = null
  constructor(private _config: Record<string, unknown>) {}

  private async pool(): Promise<any> {
    if (!this._pool) {
      const pg = await loadDriver('pg')
      const c = readDbConfig(this._config)
      // ponytail: TLS verification ON by default; opt-out via DB_SSL_REJECT_UNAUTHORIZED=0 for dev/self-signed.
      this._pool = new (pg.Pool as new (cfg: Record<string, unknown>) => unknown)({
        host: c.host,
        port: c.port || 5432,
        database: c.database,
        user: c.user,
        password: c.password,
        ssl: c.ssl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' } : undefined, // nosemgrep — verification enabled by default, opt-out only for dev
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

  async fetchSchema(): Promise<ReflectedTable[]> {
    const pool = await this.pool()
    const schema = readDbConfig(this._config).schema ?? 'public'
    // ponytail: rowCount from pg_class.reltuples (catalog estimate) — avoids
    // expensive COUNT(*) on large tables. ANALYZE refreshes the estimate.
    const tablesRes = await pool.query(
      `SELECT t.table_name,
              CASE WHEN c.reltuples IS NULL OR c.reltuples < 0 THEN 0 ELSE c.reltuples END AS row_count
       FROM information_schema.tables t
       LEFT JOIN pg_class c ON c.relname = t.table_name
       LEFT JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
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
  constructor(private _config: Record<string, unknown>) {}

  private async pool(): Promise<any> {
    if (!this._pool) {
      const mysql = await loadDriver('mysql2/promise')
      const c = readDbConfig(this._config)
      this._pool = (mysql.createPool as (cfg: Record<string, unknown>) => unknown)({
        host: c.host,
        port: c.port || 3306,
        database: c.database,
        user: c.user,
        password: c.password,
        ssl: c.ssl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== '0' } : undefined, // nosemgrep — verification enabled by default, opt-out only for dev
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
  constructor(private _config: Record<string, unknown>) {}

  private async pool(): Promise<any> {
    if (!this._pool) {
      const mssql = await loadDriver('mssql')
      const c = readDbConfig(this._config)
      // ponytail: server maps to host; requestTimeout covers all queries on this pool.
      const inst = new (mssql.ConnectionPool as unknown as new (cfg: Record<string, unknown>) => { connect(): Promise<unknown> })({
        server: c.host,
        port: c.port || 1433,
        database: c.database,
        user: c.user,
        password: c.password,
        connectionTimeout: QUERY_TIMEOUT_MS,
        requestTimeout: QUERY_TIMEOUT_MS,
        options: { encrypt: c.ssl, trustServerCertificate: !c.ssl },
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
  constructor(private _config: Record<string, unknown>) {}

  private async client(): Promise<any> {
    if (!this._client) {
      const ch = await loadDriver('@clickhouse/client')
      const c = readDbConfig(this._config)
      const createClient = ch.createClient as (opts: Record<string, unknown>) => unknown
      this._client = createClient({
        url: `https://${c.host}:${c.port || 8123}`,
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
