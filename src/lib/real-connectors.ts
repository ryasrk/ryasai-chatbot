/**
 * Real database connectors — PostgreSQL, MySQL/MariaDB, MSSQL, ClickHouse — behind `BaseDatabaseConnector`.
 *
 * Drivers are dynamically imported so the app boots without them; a clear error is thrown only when a provider is
 * actually used and its driver is missing. Each connector implements:
 *   - testConnection()  → SELECT 1, return boolean
 *   - fetchSchema()     → information_schema reflection → ReflectedTable[]
 *   - executeQuery(sql) → run validated SQL (guardrails already ran; the connector re-checks read-only lexically)
 *   - close()           → drain connection pool (called by registry.drop)
 *
 * The public surface only: one module per dialect, shared plumbing in `real-connector-shared.ts`.
 */
export { PostgresConnector } from '@/lib/real-connector-postgres'
export { MysqlConnector } from '@/lib/real-connector-mysql'
export { MssqlConnector } from '@/lib/real-connector-mssql'
export { ClickHouseConnector } from '@/lib/real-connector-clickhouse'
export {
  parseConnectionString, readDbConfig, describeConnectionError, assertNoDangerousFunctions, assertSingleStatement,
  assertSelectOnly, normaliseRow, loadDriver,
  type ConnectionFailureReason, type DetailedTestResult,
} from '@/lib/real-connector-shared'
