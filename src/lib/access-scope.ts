/**
 * Per-role data access inside one organization.
 *
 * WHY. Until 2026-10-04 every user of an org could query every reflected table and retrieve every document — a
 * `viewer` could ask for the salary column. Tenant isolation (prisma-tenant.ts) answers "which ORG"; this module
 * answers "which ROLE inside it". Two axes:
 *
 *   - SQL: an integration in `accessMode = "restricted"` grants each non-admin role only the tables (and columns) in
 *     `DataAccessPolicy`; anything ungranted is denied. Enforced twice — the schema the SQL generator sees is filtered,
 *     and the AST guard (sql-ast-guard.ts) rejects any table/column outside the grant.
 *   - Documents: `Document.allowedRoles`. Narrowed into the `documentIds` scope that retrieval already honours on every
 *     path (FTS, vector, fallback, cache key), so there is no second retrieval filter to drift.
 *
 * `admin` is never restricted. The role is read from the user row rather than threaded through every route: every
 * chat transport already carries `userId` to this point, and API-key / scheduled turns run as the org admin and are
 * bounded by the key's own scope instead. An unknown user resolves to `viewer` — the most restricted role.
 */
import { db } from '@/lib/db'
import type { SqlAccessPolicy } from '@/lib/sql-ast-guard'

export type DataRole = 'admin' | 'analyst' | 'viewer'

export const DATA_ROLES: readonly DataRole[] = ['admin', 'analyst', 'viewer']

export function normalizeRole(role: unknown): DataRole {
  return role === 'admin' || role === 'analyst' ? role : 'viewer'
}

export async function resolveUserRole(userId: string | null | undefined): Promise<DataRole> {
  if (!userId) return 'viewer'
  const user = await db.user.findFirst({ where: { id: userId }, select: { role: true } })
  return normalizeRole(user?.role)
}

/**
 * The SQL grant for `role` on one integration, or `null` when nothing is restricted (open mode, or admin).
 * Table and column names are lowercased: the AST guard compares case-insensitively.
 */
export async function loadSqlAccessPolicy(
  integration: { id: string; accessMode?: string | null },
  role: DataRole,
): Promise<SqlAccessPolicy | null> {
  if (role === 'admin' || integration.accessMode !== 'restricted') return null
  const rows = await db.dataAccessPolicy.findMany({
    where: { integrationId: integration.id, role },
    select: { tableName: true, allowedColumns: true },
  })
  const tables = new Map<string, { allowedColumns: ReadonlySet<string> | null }>()
  for (const row of rows) {
    tables.set(row.tableName.toLowerCase(), { allowedColumns: parseColumns(row.allowedColumns) })
  }
  return { tables }
}

/** A malformed column list grants NOTHING on that table rather than everything (fail-closed). */
function parseColumns(raw: string | null): ReadonlySet<string> | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed.map((c) => String(c).toLowerCase()))
  } catch {
    // fall through
  }
  return new Set()
}

interface SchemaTable {
  tableName: string
  columns: Array<{ name: string }>
  sampleRow?: Record<string, unknown>
}

/**
 * The schema the SQL generator may see under `policy`: ungranted tables removed, ungranted columns removed, and the
 * sample row stripped to granted columns — a sample row of a restricted column is a value leak into the prompt.
 */
export function filterSchemaForPolicy<T extends SchemaTable>(tables: T[], policy: SqlAccessPolicy | null): T[] {
  if (!policy) return tables
  const out: T[] = []
  for (const table of tables) {
    const grant = policy.tables.get(table.tableName.toLowerCase())
    if (!grant) continue
    const allowed = grant.allowedColumns
    if (!allowed) {
      out.push(table)
      continue
    }
    const columns = table.columns.filter((c) => allowed.has(c.name.toLowerCase()))
    const sampleRow = table.sampleRow
      ? Object.fromEntries(Object.entries(table.sampleRow).filter(([k]) => allowed.has(k.toLowerCase())))
      : table.sampleRow
    out.push({ ...table, columns, sampleRow })
  }
  return out
}

/**
 * Narrow a retrieval document scope to the documents `role` may read.
 *
 * `requested` follows the existing convention: `null`/absent/empty = every document. Returns `null` (no narrowing)
 * when the role is admin or no ready document excludes the role. Otherwise returns the allowed ids — intersected with
 * `requested` when one was given. An EMPTY result is returned as a sentinel id that matches no document, never as
 * `[]`, because `[]` means "unrestricted" to every consumer of this scope.
 */
export const NO_DOCUMENTS_SENTINEL = '__no_document_is_visible_to_this_role__'

export async function narrowDocumentScope(
  role: DataRole,
  requested: string[] | null | undefined,
): Promise<string[] | null> {
  const asked = requested && requested.length > 0 ? requested : null
  if (role === 'admin') return asked
  const hidden = await db.document.count({ where: { NOT: { allowedRoles: { has: role } } } })
  if (hidden === 0) return asked
  const visible = await db.document.findMany({
    where: { allowedRoles: { has: role }, ...(asked ? { id: { in: asked } } : {}) },
    select: { id: true },
  })
  const ids = visible.map((d) => d.id)
  return ids.length > 0 ? ids : [NO_DOCUMENTS_SENTINEL]
}

/** Prisma `where` fragment for listing documents a role may see; `{}` for admin. */
export function documentVisibilityWhere(role: DataRole): Record<string, unknown> {
  return role === 'admin' ? {} : { allowedRoles: { has: role } }
}
