/**
 * The MySQL and MariaDB connector. Shared config parsing, the lexical read-only guards, driver loading and schema assembly
 * live in `real-connector-shared.ts`; `real-connectors.ts` is the public surface that re-exports every dialect.
 */
import type { BaseDatabaseConnector, QueryResult, QueryRow, ReflectedTable } from './connectors'
import {
  QUERY_TIMEOUT_MS, MYSQL_STATEMENT_TIMEOUT_S, readDbConfig, resolveUseSsl, assertNoDangerousFunctions, assertSelectOnly, normaliseRow, loadDriver, detailedPing, assembleSchema, enrichSchema,
  type DetailedTestResult, type PingablePool, type RawColumnRow, type RawTableRow,
} from '@/lib/real-connector-shared'

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

  /** Any grant line naming a write privilege (or ALL PRIVILEGES) for the current user. */
  async probeWritePrivilege(): Promise<boolean | null> {
    try {
      const pool = await this.pool()
      const [rows] = await pool.query({ sql: 'SHOW GRANTS FOR CURRENT_USER()', timeout: QUERY_TIMEOUT_MS })
      const lines = (rows as Array<Record<string, unknown>>).map((r) => String(Object.values(r)[0] ?? ''))
      return lines.some((l) => /\bGRANT\b[^]*?\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b[^]*?\bON\b/i.test(l))
    } catch {
      return null
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
    assertNoDangerousFunctions(sql)
    const pool = await this.pool()
    const start = Date.now()
    // Read-only is enforced by the SERVER (see the READ-ONLY block comment):
    // `SET TRANSACTION READ ONLY` + `START TRANSACTION READ ONLY` make InnoDB
    // reject writes and DDL on this transaction, independent of the scanner.
    // All statements must run on the same connection, so we check one out.
    const conn = await pool.getConnection()
    try {
      // SERVER-side time bound. mysql2's `timeout` only abandons the CLIENT side: the server kept executing the slow
      // query after the caller had given up (Postgres has `statement_timeout` for exactly this). MySQL 5.7.8+ honours
      // `max_execution_time` (ms, SELECT only); MariaDB names it `max_statement_time` (seconds). A server that knows
      // neither still has the client timeout.
      await conn.query(`SET SESSION max_execution_time = ${QUERY_TIMEOUT_MS}`).catch(() =>
        conn.query(`SET SESSION max_statement_time = ${MYSQL_STATEMENT_TIMEOUT_S}`).catch(() => {}),
      )
      await conn.query('SET TRANSACTION READ ONLY')
      await conn.query('START TRANSACTION READ ONLY')
      const [rows] = await conn.query({ sql, timeout: QUERY_TIMEOUT_MS })
      await conn.commit()
      const r: QueryRow[] = (rows as QueryRow[]) ?? []
      return {
        rows: r.map((row) => normaliseRow(row)),
        rowCount: r.length,
        executionMs: Date.now() - start,
      }
    } catch (e) {
      try { await conn.rollback() } catch { /* connection is gone */ }
      throw e
    } finally {
      conn.release()
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
