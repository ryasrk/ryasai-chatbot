/**
 * The Microsoft SQL Server connector. Shared config parsing, the lexical read-only guards, driver loading and schema assembly
 * live in `real-connector-shared.ts`; `real-connectors.ts` is the public surface that re-exports every dialect.
 */
import type { BaseDatabaseConnector, QueryResult, QueryRow, ReflectedTable } from './connectors'
import {
  QUERY_TIMEOUT_MS, readDbConfig, describeConnectionError, resolveUseSsl, assertNoDangerousFunctions, assertSelectOnly, normaliseRow, loadDriver, assembleSchema, enrichSchema,
  type DetailedTestResult, type RawColumnRow, type RawTableRow,
} from '@/lib/real-connector-shared'

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
        // ponytail: MSSQL cannot mark a transaction read-only, so we ask the
        // server for a read-only intent instead — on an Availability Group this
        // routes the connection to a secondary replica. No-op elsewhere.
        options: {
          encrypt: useSsl,
          trustServerCertificate: !useSsl,
          appName: 'ryasai-chatbot',
          readOnlyIntent: true,
        },
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

  /** Database-level INSERT/UPDATE/DELETE permission, or sysadmin, for the current login. */
  async probeWritePrivilege(): Promise<boolean | null> {
    try {
      const pool = await this.pool()
      const res = await pool.request().query(
        `SELECT CAST(CASE WHEN IS_SRVROLEMEMBER('sysadmin') = 1
                       OR HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT') = 1
                       OR HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'UPDATE') = 1
                       OR HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'DELETE') = 1
                  THEN 1 ELSE 0 END AS bit) AS writable`,
      )
      const v = (res.recordset as Array<{ writable?: unknown }> | undefined)?.[0]?.writable
      return typeof v === 'boolean' ? v : v === 1 ? true : v === 0 ? false : null
    } catch {
      return null
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
    assertNoDangerousFunctions(sql)
    const pool = await this.pool()
    const start = Date.now()
    // MSSQL has no per-transaction READ ONLY mode, so the query runs inside a transaction that is ALWAYS rolled back:
    // any data write that slipped past the scanners is undone by the server. Stated precisely, because it is not a
    // read-only guarantee: effects OUTSIDE the transaction (xp_cmdshell, linked servers, mail, sequence/identity
    // increments) are not undone — `assertNoDangerousFunctions` above denies those families, and a least-privilege
    // login remains the real boundary. ApplicationIntent=ReadOnly is
    // still set on the pool so an Availability Group routes to a read replica.
    const tx = pool.transaction()
    await tx.begin()
    let result: { recordset?: unknown }
    try {
      result = await tx.request().query(sql)
    } finally {
      // After an error with XACT_ABORT the server may already have rolled back; that rejection is not a failure.
      await tx.rollback().catch(() => {})
    }
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
