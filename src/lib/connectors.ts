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

export interface ReflectedColumn {
  name: string
  type: string
}
export interface ReflectedTable {
  tableName: string
  columns: ReflectedColumn[]
  rowCount?: number
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
    for (const t of DEMO_TABLES) {
      // PRAGMA + table names cannot be parameterised — use Unsafe with the validated constant.
      const cols = await db.$queryRawUnsafe<{ name: string; type: string }[]>(
        `PRAGMA table_info(${t});`,
      )
      const countRow = await db.$queryRawUnsafe<{ c: number }[]>(
        `SELECT COUNT(*) as c FROM ${t};`,
      )
      tables.push({
        tableName: t,
        columns: cols.map((c) => ({ name: String(c.name), type: String(c.type) })),
        rowCount: Number(countRow[0]?.c ?? 0),
      })
    }
    return tables
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    await ensureDemoSchema()
    const start = Date.now()
    // Prisma cannot parameterise identifiers, but the guardrail already validated.
    // We run via $queryRawUnsafe because the SQL is LLM-generated + AST-validated.
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
      let connector: BaseDatabaseConnector
      switch (provider) {
        case 'SQLITE_DEMO':
          connector = new SqliteDemoConnector(decryptedConfig)
          break
        case 'POSTGRESQL':
        case 'MYSQL':
        case 'MSSQL':
          // In the sandbox we cannot reach these; fall back to the demo connector
          // so the end-to-end experience still works. (Factory point preserved.)
          connector = new SqliteDemoConnector(decryptedConfig)
          break
        default:
          throw new Error(`Provider ${provider} tidak didukung.`)
      }
      this._pools.set(integrationId, connector)
    }
    return this._pools.get(integrationId)!
  }

  drop(integrationId: string) {
    this._pools.delete(integrationId)
  }
}

export const connectorRegistry = new ConnectorRegistry()

// ---------------------------------------------------------------------------
// Demo schema bootstrap — populates a realistic ERP dataset on first use.
// ---------------------------------------------------------------------------

let _bootstrapped = false
export async function ensureDemoSchema(): Promise<void> {
  if (_bootstrapped) return
  _bootstrapped = true

  // Prisma's $executeRawUnsafe runs ONE statement at a time — split them.
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
  for (const stmt of ddl) {
    await db.$executeRawUnsafe(stmt)
  }

  // Seed only if empty
  const c = await db.$queryRaw<{ c: number }[]>`SELECT COUNT(*) as c FROM demo_products;`
  if (Number(c[0]?.c) > 0) return

  await db.$executeRawUnsafe(`INSERT INTO demo_warehouses (id, name, location, capacity) VALUES (1, 'Gudang Utama Jakarta', 'Jakarta Barat', 50000), (2, 'Gudang Surabaya', 'Surabaya', 30000), (3, 'Gudang Bandung', 'Bandung', 20000)`)

  await db.$executeRawUnsafe(`INSERT INTO demo_products (sku, name, category, unit_price, cost, is_active) VALUES ('SKU-901', 'Laptop Enterprise 14"', 'Elektronik', 18500000, 15200000, 1), ('SKU-902', 'Mouse Wireless Pro', 'Aksesoris', 285000, 190000, 1), ('SKU-903', 'Keyboard Mekanik', 'Aksesoris', 750000, 520000, 1), ('SKU-904', 'Monitor 27" 4K', 'Elektronik', 4200000, 3350000, 1), ('SKU-905', 'SSD NVMe 1TB', 'Penyimpanan', 1450000, 1100000, 1), ('SKU-906', 'Webcam HD 1080p', 'Aksesoris', 395000, 260000, 1), ('SKU-907', 'Headset Noise Cancel', 'Audio', 1290000, 880000, 1), ('SKU-908', 'Docking Station USB-C', 'Aksesoris', 1850000, 1350000, 1), ('SKU-909', 'Router WiFi 6', 'Jaringan', 1450000, 980000, 1), ('SKU-910', 'UPS 1500VA', 'Power', 1750000, 1200000, 1)`)

  await db.$executeRawUnsafe(`INSERT INTO demo_inventory (sku, warehouse_id, quantity, reorder_level, last_updated) VALUES ('SKU-901', 1, 1420, 100, '2026-06-01'), ('SKU-901', 2, 340, 100, '2026-06-01'), ('SKU-902', 1, 5800, 500, '2026-06-01'), ('SKU-902', 2, 2100, 500, '2026-06-01'), ('SKU-903', 1, 1200, 200, '2026-06-01'), ('SKU-904', 1, 450, 80, '2026-06-01'), ('SKU-904', 3, 180, 80, '2026-06-01'), ('SKU-905', 1, 3200, 300, '2026-06-01'), ('SKU-906', 1, 2750, 300, '2026-06-01'), ('SKU-907', 1, 890, 150, '2026-06-01'), ('SKU-908', 2, 540, 100, '2026-06-01'), ('SKU-909', 1, 1120, 200, '2026-06-01'), ('SKU-910', 3, 95, 100, '2026-06-01')`)

  await db.$executeRawUnsafe(`INSERT INTO demo_customers (id, name, email, segment, city, total_spent) VALUES (1, 'PT Maju Bersama', 'procurement@majubersama.co.id', 'Enterprise', 'Jakarta', 145000000), (2, 'CV Sentosa Jaya', 'beli@sentosajaya.id', 'SMB', 'Bandung', 28500000), (3, 'PT Global Teknologi', 'it@globaltek.id', 'Enterprise', 'Surabaya', 98000000), (4, 'UD Berkah Mandiri', 'admin@berkahmandiri.com', 'SMB', 'Semarang', 12300000), (5, 'PT Sinar Digital', 'ops@sinar.digital', 'Enterprise', 'Jakarta', 67500000), (6, 'CV Karya Abadi', 'po@karyaabadi.id', 'SMB', 'Yogyakarta', 18900000), (7, 'PT Nusantara Raya', 'proc@nusantararaya.co.id', 'Enterprise', 'Medan', 53000000)`)

  await db.$executeRawUnsafe(`INSERT INTO demo_orders (id, customer_id, order_date, status, total_amount) VALUES (1001, 1, '2026-05-12', 'delivered', 18500000), (1002, 3, '2026-05-15', 'delivered', 8400000), (1003, 5, '2026-05-18', 'shipped', 4200000), (1004, 1, '2026-05-22', 'delivered', 1450000), (1005, 2, '2026-05-25', 'delivered', 855000), (1006, 7, '2026-05-28', 'shipped', 1290000), (1007, 3, '2026-06-02', 'processing', 3700000), (1008, 5, '2026-06-05', 'delivered', 5800000), (1009, 6, '2026-06-08', 'processing', 1850000), (1010, 1, '2026-06-10', 'delivered', 22500000)`)

  await db.$executeRawUnsafe(`INSERT INTO demo_order_items (order_id, sku, quantity, unit_price) VALUES (1001, 'SKU-901', 1, 18500000), (1002, 'SKU-904', 2, 4200000), (1003, 'SKU-905', 3, 1450000), (1004, 'SKU-902', 5, 285000), (1005, 'SKU-903', 1, 750000), (1006, 'SKU-907', 1, 1290000), (1007, 'SKU-904', 1, 4200000), (1007, 'SKU-906', 3, 395000), (1008, 'SKU-901', 1, 1850000), (1008, 'SKU-909', 1, 1450000), (1009, 'SKU-905', 1, 1450000), (1010, 'SKU-901', 1, 18500000)`)

  await db.$executeRawUnsafe(`INSERT INTO demo_invoices (invoice_no, customer_id, invoice_date, amount, status) VALUES ('INV-2026-001', 1, '2026-05-12', 18500000, 'paid'), ('INV-2026-002', 3, '2026-05-15', 8400000, 'paid'), ('INV-2026-003', 5, '2026-05-18', 4200000, 'pending'), ('INV-2026-004', 1, '2026-05-22', 1450000, 'paid'), ('INV-2026-005', 2, '2026-05-25', 855000, 'paid'), ('INV-2026-006', 7, '2026-05-28', 1290000, 'pending'), ('INV-2026-007', 3, '2026-06-02', 3700000, 'overdue'), ('INV-2026-008', 5, '2026-06-05', 5800000, 'paid'), ('INV-2026-009', 6, '2026-06-08', 1850000, 'pending'), ('INV-2026-010', 1, '2026-06-10', 22500000, 'paid')`)

  await db.$executeRawUnsafe(`INSERT INTO demo_employees (id, name, department, role, hire_date, salary) VALUES (1, 'Budi Santoso', 'IT', 'Manager', '2020-03-15', 25000000), (2, 'Siti Rahayu', 'Finance', 'Staff', '2021-07-01', 12000000), (3, 'Andi Wijaya', 'Sales', 'Manager', '2019-11-10', 23000000), (4, 'Dewi Lestari', 'HR', 'Staff', '2022-02-14', 11000000), (5, 'Rudi Hartono', 'Operations', 'Staff', '2021-09-20', 12500000), (6, 'Maya Putri', 'IT', 'Staff', '2023-01-05', 13500000), (7, 'Joko Susilo', 'Sales', 'Staff', '2020-08-12', 11500000)`)
}

/** Build a compact schema description string for the LLM Text-to-SQL prompt. */
export function describeSchema(tables: ReflectedTable[]): string {
  return tables
    .map(
      (t) =>
        `TABLE ${t.tableName} (${t.rowCount ?? '?'} rows)\n  ` +
        t.columns.map((c) => `${c.name} ${c.type}`).join(', '),
    )
    .join('\n\n')
}
