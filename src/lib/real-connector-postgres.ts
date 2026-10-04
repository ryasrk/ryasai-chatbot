/**
 * The PostgreSQL connector. Shared config parsing, the lexical read-only guards, driver loading and schema assembly
 * live in `real-connector-shared.ts`; `real-connectors.ts` is the public surface that re-exports every dialect.
 */
import type { BaseDatabaseConnector, QueryResult, QueryRow, ReflectedTable } from './connectors'
import {
  QUERY_TIMEOUT_MS,
  readDbConfig,
  resolveUseSsl,
  assertNoDangerousFunctions,
  assertSelectOnly,
  normaliseRow,
  loadDriver,
  detailedPing,
  assembleSchema,
  enrichSchema,
  type DetailedTestResult,
  type PingablePool,
  type RawColumnRow,
  type RawTableRow,
} from '@/lib/real-connector-shared'

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

  /** Superuser, ownership of a user table, or an INSERT/UPDATE/DELETE/TRUNCATE grant on one, all mean "can write". */
  async probeWritePrivilege(): Promise<boolean | null> {
    try {
      const pool = await this.pool()
      const res = await pool.query(`
        SELECT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
          OR EXISTS (SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND tableowner = current_user)
          OR EXISTS (SELECT 1 FROM information_schema.table_privileges
                     WHERE grantee IN (current_user, 'PUBLIC')
                       AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
                       AND table_schema NOT IN ('pg_catalog', 'information_schema')) AS writable`)
      const v = res.rows?.[0]?.writable
      return typeof v === 'boolean' ? v : null
    } catch {
      return null
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
              CASE WHEN c.reltuples IS NULL OR c.reltuples < 0 THEN -1 ELSE c.reltuples END AS row_count
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
    assertNoDangerousFunctions(sql)
    const pool = await this.pool()
    const start = Date.now()
    // Read-only is enforced by the DATABASE, not by the scanner: `SET
    // TRANSACTION READ ONLY` makes the server itself reject writes and DDL
    // ("cannot execute INSERT … in a read-only transaction").
    //
    // It is NOT a complete control on its own — pg_read_file/set_config/
    // pg_sleep are reads, so read-only mode allows them. Those are covered by
    // assertNoDangerousFunctions() above and by statement_timeout below. See
    // the READ-ONLY block comment for the measurements.
    //
    // The pool hands us one backend, so BEGIN/SET/SELECT/COMMIT must all run on
    // the SAME client — hence an explicit connect() instead of pool.query().
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET TRANSACTION READ ONLY')
      // ponytail: verify what this DOES and does NOT buy us — measured against
      // Postgres 16, scanners bypassed:
      //   BLOCKED: INSERT/UPDATE/DELETE/TRUNCATE/DDL ("cannot execute … in a
      //            read-only transaction")
      //   ALLOWED: pg_read_file(), set_config(), pg_sleep() — these are not
      //            writes, so read-only mode does not cover them.
      // The file/config readers are therefore handled by
      // assertNoDangerousFunctions() above, and pg_sleep by the server-side
      // statement_timeout below. Read-only mode is the backstop for the whole
      // mutation class the scanner can never fully enumerate.
      await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`)
      const result = await client.query(sql)
      // Re-assert the ceiling AFTER the query. `assertSingleStatement()` above is the real control,
      // but a batch that ever slipped past it could have run `SET LOCAL statement_timeout = 0` inside
      // the query string; restoring it here means the next statement on this pooled backend cannot
      // inherit a disabled timeout. Cheap (one round trip) and it closes the pooled-connection path.
      await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`)
      await client.query('COMMIT')
      const rows: QueryRow[] = (result.rows as QueryRow[]) ?? []
      return {
        rows: rows.map((r) => normaliseRow(r)),
        rowCount: result.rowCount ?? rows.length,
        executionMs: Date.now() - start,
      }
    } catch (e) {
      // ROLLBACK is best-effort: if the connection already died the client is
      // being discarded anyway, and masking the original error would hide the
      // real SQL failure from the repair loop.
      try { await client.query('ROLLBACK') } catch { /* connection is gone */ }
      throw e
    } finally {
      client.release()
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
