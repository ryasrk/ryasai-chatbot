/**
 * 3.1 / 3.2 — Dynamic Connector Factory & Registry
 * ----------------------------------------------------------------------------
 * Adapted from spec's Python ABC `BaseDatabaseConnector` + `ConnectorRegistry`.
 *
 * Because the sandbox cannot reach external PostgreSQL/MySQL, we ship a
 * `SqliteDemoConnector` that operates on a managed "client data" schema inside
 * the SAME SQLite DB. This keeps Text-to-SQL fully functional end-to-end while
 * honouring the Factory + Registry pattern (admin registers a connector via UI,
 * config is AES-encrypted, schema is auto-reflected, queries run through guardrails).
 *
 * The base class is provider-agnostic, so adding real Postgres/MySQL connectors
 * later only means registering a new subclass in `ConnectorRegistry.getConnector`.
 */
import { db } from '@/lib/db'
import { getDbProvider } from '@/lib/db-provider'
import { getDbProtocolFamily } from '@/lib/db-provider-presets'
import { PostgresConnector, MysqlConnector, MssqlConnector } from './real-connectors'

const isPostgres = () => getDbProvider() === 'postgresql'

export interface ReflectedColumn {
  name: string
  type: string
  primaryKey?: boolean
  notNull?: boolean
  foreignKey?: string
  distinctValues?: string[]
}
export interface ReflectedTable {
  tableName: string
  columns: ReflectedColumn[]
  rowCount?: number
  sampleRow?: QueryRow
}
export interface QueryRow {
  [column: string]: unknown
}
export interface QueryResult {
  rows: QueryRow[]
  rowCount: number
  executionMs: number
}

export interface BaseDatabaseConnector {
  readonly provider: string
  testConnection(): Promise<boolean>
  fetchSchema(): Promise<ReflectedTable[]>
  executeQuery(sql: string): Promise<QueryResult>
  // ponytail: optional — only real connectors with pools implement this.
  close?(): Promise<void>
}

// ---------------------------------------------------------------------------
// SQLite Demo Connector — simulates an external client database.
// The "client" schema lives in tables prefixed `demo_` inside custom.db.
// ---------------------------------------------------------------------------

const DEMO_TABLES = [
  'demo_products',
  'demo_inventory',
  'demo_customers',
  'demo_orders',
  'demo_order_items',
  'demo_warehouses',
  'demo_invoices',
  'demo_employees',
] as const

// Allowlist set (lower-cased). The demo connector only ever owns these tables —
// any FROM/JOIN target outside it is rejected before $queryRawUnsafe runs.
const DEMO_TABLE_SET = new Set(DEMO_TABLES.map((t) => t.toLowerCase()))

/**
 * Defence-in-depth table allowlist. Extracts every FROM/JOIN table reference
 * and rejects the SQL unless ALL of them are demo tables. This prevents a
 * prompt-injected SELECT from reading the app's own tables (User, Session,
 * LlmConfig, Integration, sqlite_master, …) which live in the SAME SQLite file.
 */
function assertDemoTablesOnly(sql: string): void {
  const re = /\b(?:from|join)\s+["`]?([A-Za-z_][\w]*)["`]?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const tbl = m[1].toLowerCase()
    if (!DEMO_TABLE_SET.has(tbl)) {
      throw new Error(
        `Security violation: table access outside allowlist (${m[1]}). Only demo_ tables are allowed.`,
      )
    }
  }
}

export class SqliteDemoConnector implements BaseDatabaseConnector {
  readonly provider = 'SQLITE_DEMO'
  constructor(private _config: Record<string, unknown>) {}

  async testConnection(): Promise<boolean> {
    await ensureDemoSchema()
    return true
  }

  async fetchSchema(): Promise<ReflectedTable[]> {
    await ensureDemoSchema()
    const tables: ReflectedTable[] = []

    // Pass 1 — basic column info with pk + notnull from PRAGMA (SQLite) or information_schema (Postgres)
    for (const t of DEMO_TABLES) {
      const cols = isPostgres()
        ? await db.$queryRawUnsafe<{ name: string; type: string; notnull: number; pk: number }[]>(
            `SELECT c.column_name AS name, c.data_type AS type, CASE WHEN c.is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull, CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END AS pk FROM information_schema.columns c LEFT JOIN (SELECT ku.column_name, ku.table_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name WHERE tc.constraint_type = 'PRIMARY KEY') pk ON pk.column_name = c.column_name AND pk.table_name = c.table_name WHERE c.table_name = $1 ORDER BY c.ordinal_position`,
            t,
          )
        : await db.$queryRawUnsafe<{ name: string; type: string; notnull: number; pk: number }[]>(
            `PRAGMA table_info(${t});`,
          )
      const countRow = await db.$queryRawUnsafe<{ c: number }[]>(
        `SELECT COUNT(*) as c FROM ${t};`,
      )
      tables.push({
        tableName: t,
        columns: cols.map((c) => ({
          name: String(c.name),
          type: String(c.type),
          primaryKey: Number(c.pk) > 0,
          notNull: Number(c.notnull) === 1,
        })),
        rowCount: Number(countRow[0]?.c ?? 0),
      })
    }

    // Pass 2 — infer FKs from {prefix}_id naming convention
    for (const table of tables) {
      for (const col of table.columns) {
        if (col.primaryKey || !col.name.endsWith('_id')) continue
        const prefix = col.name.slice(0, -3)
        const candidates = [prefix, `${prefix}s`, `demo_${prefix}`, `demo_${prefix}s`]
        for (const candidate of candidates) {
          const refTable = tables.find((t) => t.tableName === candidate)
          if (refTable) {
            const pkCol = refTable.columns.find((c) => c.primaryKey)
            if (pkCol) col.foreignKey = `${refTable.tableName}.${pkCol.name}`
            break
          }
        }
      }
    }

    // Pass 3 — sample distinct values for low-cardinality TEXT columns
    for (const table of tables) {
      if (!table.rowCount || table.rowCount > 10000) continue
      for (const col of table.columns) {
        if (col.primaryKey || col.foreignKey) continue
        const upperType = col.type.toUpperCase()
        if (!upperType.includes('TEXT') && !upperType.includes('VARCHAR') && !upperType.includes('CHAR')) continue
        try {
          const distinctRows = await db.$queryRawUnsafe<{ v: string | null }[]>(
            `SELECT DISTINCT "${col.name}" AS v FROM "${table.tableName}" LIMIT 21;`,
          )
          if (distinctRows.length <= 20) {
            col.distinctValues = distinctRows
              .map((r) => (r.v === null ? 'NULL' : String(r.v)))
              .filter((v) => v !== 'NULL')
          }
        } catch {
          // skip on error — non-fatal
        }
      }
    }

    // Pass 4 — fetch 1 sample row per table for LLM format understanding
    for (const table of tables) {
      if (!table.rowCount || table.rowCount === 0) continue
      try {
        const colNames = table.columns.map((c) => `"${c.name}"`).join(', ')
        const rows = await db.$queryRawUnsafe<QueryRow[]>(
          `SELECT ${colNames} FROM "${table.tableName}" LIMIT 1;`,
        )
        if (rows.length > 0) table.sampleRow = normaliseRow(rows[0])
      } catch {
        // skip on error — non-fatal
      }
    }

    return tables
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    await ensureDemoSchema()
    // Defence-in-depth: only demo_* tables may be read. The guardrail already
    // enforces SELECT-only; this closes the "read auth/system tables" gap.
    assertDemoTablesOnly(sql)
    const start = Date.now()
    // Prisma cannot parameterise identifiers, but the SQL is LLM-generated +
    // AST-validated (guardrail) + table-allowlisted (above).
    const rows = await db.$queryRawUnsafe<QueryRow[]>(sql)
    const exec = Date.now() - start
    return { rows: rows.map((r) => normaliseRow(r)), rowCount: rows.length, executionMs: exec }
  }
}

function normaliseRow(r: QueryRow): QueryRow {
  const out: QueryRow = {}
  for (const [k, v] of Object.entries(r)) {
    if (v instanceof Date) out[k] = v.toISOString()
    else if (typeof v === 'bigint') out[k] = Number(v)
    else if (v && typeof v === 'object' && 'toISOString' in v) out[k] = String(v)
    else out[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Registry  (spec §3.2)
// ---------------------------------------------------------------------------

export class ConnectorRegistry {
  private _pools = new Map<string, BaseDatabaseConnector>()

  getConnector(integrationId: string, provider: string, decryptedConfig: Record<string, unknown>): BaseDatabaseConnector {
    if (!this._pools.has(integrationId)) {
      const family = getDbProtocolFamily(provider)
      let connector: BaseDatabaseConnector
      switch (family) {
        case 'SQLITE_DEMO':
          connector = new SqliteDemoConnector(decryptedConfig)
          break
        case 'POSTGRESQL':
          connector = new PostgresConnector(decryptedConfig)
          break
        case 'MYSQL':
          connector = new MysqlConnector(decryptedConfig)
          break
        case 'MSSQL':
          connector = new MssqlConnector(decryptedConfig)
          break
        case 'MONGODB':
        case 'CLICKHOUSE':
        case 'SNOWFLAKE':
        case 'ORACLE':
          // ponytail: not in scope — demo connector stub until real drivers land.
          connector = new SqliteDemoConnector(decryptedConfig)
          break
        default:
          throw new Error(`Provider ${provider} is not supported.`)
      }
      this._pools.set(integrationId, connector)
    }
    return this._pools.get(integrationId)!
  }

  drop(integrationId: string) {
    const c = this._pools.get(integrationId)
    this._pools.delete(integrationId)
    // ponytail: fire-and-forget pool cleanup — keeps drop() sync for existing callers.
    if (c?.close) c.close().catch(() => {})
  }
}

export const connectorRegistry = new ConnectorRegistry()

// ---------------------------------------------------------------------------
// Demo schema bootstrap — populates a realistic ERP dataset on first use.
// ---------------------------------------------------------------------------
let _bootstrapped = false

export function resetDemoSchemaBootstrap() { _bootstrapped = false }

export async function ensureDemoSchema(): Promise<void> {
  if (_bootstrapped) return
  _bootstrapped = true

  // Prisma's $executeRawUnsafe runs ONE statement at a time — split them.
  // ponytail: Postgres replaces AUTOINCREMENT with GENERATED BY DEFAULT AS IDENTITY
  // (allows explicit-id inserts from seed, auto-generates when id omitted).
  const ddl = [
    `CREATE TABLE IF NOT EXISTS demo_warehouses (id INTEGER PRIMARY KEY, name TEXT NOT NULL, location TEXT, capacity INTEGER)`,
    `CREATE TABLE IF NOT EXISTS demo_products (sku TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT, unit_price REAL, cost REAL, is_active INTEGER DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS demo_inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, warehouse_id INTEGER NOT NULL, quantity INTEGER NOT NULL, reorder_level INTEGER, last_updated TEXT)`,
    `CREATE TABLE IF NOT EXISTS demo_customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, segment TEXT, city TEXT, total_spent REAL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS demo_orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, order_date TEXT NOT NULL, status TEXT, total_amount REAL)`,
    `CREATE TABLE IF NOT EXISTS demo_order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, sku TEXT NOT NULL, quantity INTEGER, unit_price REAL)`,
    `CREATE TABLE IF NOT EXISTS demo_invoices (invoice_no TEXT PRIMARY KEY, customer_id INTEGER, invoice_date TEXT, amount REAL, status TEXT)`,
    `CREATE TABLE IF NOT EXISTS demo_employees (id INTEGER PRIMARY KEY, name TEXT, department TEXT, role TEXT, hire_date TEXT, salary REAL)`,
  ]
  const finalDdl = isPostgres()
    ? ddl.map((s) => s.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY'))
    : ddl
  for (const stmt of finalDdl) {
    await db.$executeRawUnsafe(stmt)
  }

  // Seed only if empty
  const c = await db.$queryRaw<{ c: number }[]>`SELECT COUNT(*) as c FROM demo_products;`
  if (Number(c[0]?.c) > 0) return

  await db.$executeRawUnsafe(`INSERT INTO demo_warehouses (id, name, location, capacity) VALUES (1, 'Jakarta Main Warehouse', 'West Jakarta', 50000), (2, 'Surabaya Warehouse', 'Surabaya', 30000), (3, 'Bandung Warehouse', 'Bandung', 20000)`)

  await db.$executeRawUnsafe(`INSERT INTO demo_products (sku, name, category, unit_price, cost, is_active) VALUES ('SKU-901', 'Laptop Enterprise 14"', 'Electronics', 18500000, 15200000, 1), ('SKU-902', 'Mouse Wireless Pro', 'Accessories', 285000, 190000, 1), ('SKU-903', 'Mechanical Keyboard', 'Accessories', 750000, 520000, 1), ('SKU-904', 'Monitor 27" 4K', 'Electronics', 4200000, 3350000, 1), ('SKU-905', 'SSD NVMe 1TB', 'Storage', 1450000, 1100000, 1), ('SKU-906', 'Webcam HD 1080p', 'Accessories', 395000, 260000, 1), ('SKU-907', 'Headset Noise Cancel', 'Audio', 1290000, 880000, 1), ('SKU-908', 'Docking Station USB-C', 'Accessories', 1850000, 1350000, 1), ('SKU-909', 'Router WiFi 6', 'Networking', 1450000, 980000, 1), ('SKU-910', 'UPS 1500VA', 'Power', 1750000, 1200000, 1)`)

  await db.$executeRawUnsafe(`INSERT INTO demo_inventory (sku, warehouse_id, quantity, reorder_level, last_updated) VALUES ('SKU-901', 1, 1420, 100, '2026-06-01'), ('SKU-901', 2, 340, 100, '2026-06-01'), ('SKU-902', 1, 5800, 500, '2026-06-01'), ('SKU-902', 2, 2100, 500, '2026-06-01'), ('SKU-903', 1, 1200, 200, '2026-06-01'), ('SKU-904', 1, 450, 80, '2026-06-01'), ('SKU-904', 3, 180, 80, '2026-06-01'), ('SKU-905', 1, 3200, 300, '2026-06-01'), ('SKU-906', 1, 2750, 300, '2026-06-01'), ('SKU-907', 1, 890, 150, '2026-06-01'), ('SKU-908', 2, 540, 100, '2026-06-01'), ('SKU-909', 1, 1120, 200, '2026-06-01'), ('SKU-910', 3, 95, 100, '2026-06-01')`)

  await db.$executeRawUnsafe(`INSERT INTO demo_customers (id, name, email, segment, city, total_spent) VALUES (1, 'PT Forward Together', 'proc@forwardtogether.co.id', 'Enterprise', 'Jakarta', 145000000), (2, 'CV Prosperous Success', 'purchases@prosperoussuccess.id', 'SMB', 'Bandung', 28500000), (3, 'PT Global Technology', 'it@globaltech.id', 'Enterprise', 'Surabaya', 98000000), (4, 'UD Independent Blessing', 'admin@independentblessing.com', 'SMB', 'Semarang', 12300000), (5, 'PT Digital Light', 'ops@digitallight.digital', 'Enterprise', 'Jakarta', 67500000), (6, 'CV Eternal Creation', 'po@eternalcreation.id', 'SMB', 'Yogyakarta', 18900000), (7, 'PT Great Nusantara', 'proc@greatnusantara.co.id', 'Enterprise', 'Medan', 53000000)`)

  await db.$executeRawUnsafe(`INSERT INTO demo_orders (id, customer_id, order_date, status, total_amount) VALUES (1001, 1, '2026-05-12', 'delivered', 18500000), (1002, 3, '2026-05-15', 'delivered', 8400000), (1003, 5, '2026-05-18', 'shipped', 4200000), (1004, 1, '2026-05-22', 'delivered', 1450000), (1005, 2, '2026-05-25', 'delivered', 855000), (1006, 7, '2026-05-28', 'shipped', 1290000), (1007, 3, '2026-06-02', 'processing', 3700000), (1008, 5, '2026-06-05', 'delivered', 5800000), (1009, 6, '2026-06-08', 'processing', 1850000), (1010, 1, '2026-06-10', 'delivered', 22500000)`)

  await db.$executeRawUnsafe(`INSERT INTO demo_order_items (order_id, sku, quantity, unit_price) VALUES (1001, 'SKU-901', 1, 18500000), (1002, 'SKU-904', 2, 4200000), (1003, 'SKU-905', 3, 1450000), (1004, 'SKU-902', 5, 285000), (1005, 'SKU-903', 1, 750000), (1006, 'SKU-907', 1, 1290000), (1007, 'SKU-904', 1, 4200000), (1007, 'SKU-906', 3, 395000), (1008, 'SKU-901', 1, 1850000), (1008, 'SKU-909', 1, 1450000), (1009, 'SKU-905', 1, 1450000), (1010, 'SKU-901', 1, 18500000)`)

  await db.$executeRawUnsafe(`INSERT INTO demo_invoices (invoice_no, customer_id, invoice_date, amount, status) VALUES ('INV-2026-001', 1, '2026-05-12', 18500000, 'paid'), ('INV-2026-002', 3, '2026-05-15', 8400000, 'paid'), ('INV-2026-003', 5, '2026-05-18', 4200000, 'pending'), ('INV-2026-004', 1, '2026-05-22', 1450000, 'paid'), ('INV-2026-005', 2, '2026-05-25', 855000, 'paid'), ('INV-2026-006', 7, '2026-05-28', 1290000, 'pending'), ('INV-2026-007', 3, '2026-06-02', 3700000, 'overdue'), ('INV-2026-008', 5, '2026-06-05', 5800000, 'paid'), ('INV-2026-009', 6, '2026-06-08', 1850000, 'pending'), ('INV-2026-010', 1, '2026-06-10', 22500000, 'paid')`)

  await db.$executeRawUnsafe(`INSERT INTO demo_employees (id, name, department, role, hire_date, salary) VALUES (1, 'Budi Santoso', 'IT', 'Manager', '2020-03-15', 25000000), (2, 'Siti Rahayu', 'Finance', 'Staff', '2021-07-01', 12000000), (3, 'Andi Wijaya', 'Sales', 'Manager', '2019-11-10', 23000000), (4, 'Dewi Lestari', 'HR', 'Staff', '2022-02-14', 11000000), (5, 'Rudi Hartono', 'Operations', 'Staff', '2021-09-20', 12500000), (6, 'Maya Putri', 'IT', 'Staff', '2023-01-05', 13500000), (7, 'Joko Susilo', 'Sales', 'Staff', '2020-08-12', 11500000)`)
}

/** Build a compact schema description string for the LLM Text-to-SQL prompt. */
export function describeSchema(tables: ReflectedTable[]): string {
  return tables
    .map((t) => {
      const pkCols = t.columns.filter((c) => c.primaryKey).map((c) => c.name)
      const pkLabel = pkCols.length > 0 ? `  PK: ${pkCols.join(', ')}` : ''
      const header = `TABLE ${t.tableName} (${t.rowCount ?? '?'} rows)${pkLabel}`
      const cols = t.columns
        .map((c) => {
          let line = `  ${c.name} ${c.type}`
          if (c.primaryKey) line += ' PRIMARY KEY'
          else if (c.notNull) line += ' NOT NULL'
          if (c.foreignKey) line += ` -> ${c.foreignKey}`
          if (c.distinctValues && c.distinctValues.length > 0) {
            line += `  -- values: ${c.distinctValues.join(', ')}`
          }
          return line
        })
        .join('\n')
      let sample = ''
      if (t.sampleRow) {
        const parts = t.columns
          .filter((c) => t.sampleRow![c.name] !== undefined && t.sampleRow![c.name] !== null)
          .map((c) => {
            const v = t.sampleRow![c.name]
            const sv = typeof v === 'string' ? `'${v.length > 40 ? v.slice(0, 37) + '...' : v}'` : String(v)
            return `${c.name}=${sv}`
          })
        if (parts.length > 0) sample = `  -- sample: ${parts.join(', ')}`
      }
      return `${header}\n${cols}${sample ? '\n' + sample : ''}`
    })
    .join('\n\n')
}
