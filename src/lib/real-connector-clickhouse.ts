/**
 * The ClickHouse connector. Shared config parsing, the lexical read-only guards, driver loading and schema assembly
 * live in `real-connector-shared.ts`; `real-connectors.ts` is the public surface that re-exports every dialect.
 */
import type { BaseDatabaseConnector, QueryResult, QueryRow, ReflectedTable } from './connectors'
import {
  QUERY_TIMEOUT_MS, readDbConfig, describeConnectionError, resolveUseSsl, assertNoDangerousFunctions, assertSelectOnly, normaliseRow, loadDriver,
  type DetailedTestResult,
} from '@/lib/real-connector-shared'

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
        // ponytail: readonly=1 makes the SERVER reject writes/DDL on this client
        // (previously absent — only the scanner stood between the LLM and the
        // data). `max_execution_time` bounds runaway scans; the client also gets
        // request_timeout because only testConnectionDetailed had one, leaving
        // executeQuery able to hang a chat turn indefinitely.
        // Note: readonly=1 does NOT cover file()/url()/s3()/remote() table
        // functions — those are denied by assertNoDangerousFunctions().
        request_timeout: QUERY_TIMEOUT_MS,
        clickhouse_settings: {
          readonly: 1,
          max_execution_time: Math.ceil(QUERY_TIMEOUT_MS / 1000),
        },
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
    // SECURITY: `database` is admin-settable from the integration form, and this
    // query used to interpolate it as a literal (`t.database = '${db}'`). A name
    // containing a single quote closed the literal and changed the query — the
    // only connector in this file that did not bind its schema name. ClickHouse's
    // own parameter syntax is used here: {db:String} with query_params, which the
    // server sends out-of-band rather than concatenated into the SQL text.
    const rs = await cl.query({
      query: `SELECT t.name AS table_name, t.engine AS engine, c.name AS col_name, c.type AS col_type, c.position AS col_pos, c.is_in_primary_key AS pk FROM system.tables t LEFT JOIN system.columns c ON t.database = c.database AND t.name = c.table WHERE t.database = {db:String} AND t.engine NOT LIKE '%Materialized%' ORDER BY t.name, c.position FORMAT JSONEachRow`,
      query_params: { db },
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
    assertNoDangerousFunctions(sql)
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
