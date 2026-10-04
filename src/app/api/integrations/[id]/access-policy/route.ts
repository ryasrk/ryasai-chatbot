/**
 * GET /api/integrations/[id]/access-policy — the integration's access mode and per-role table/column grants.
 * PUT /api/integrations/[id]/access-policy — replace them.
 *
 * Admin-only. The grants are what `sql-pipeline.ts` (schema the generator sees) and `sql-ast-guard.ts` (tables and
 * columns a query may read) enforce for `analyst` and `viewer` when `accessMode = "restricted"`; `admin` is never
 * restricted, so it has no grant rows.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { getActiveUser, handleApiError, requireRole, writeAudit } from '@/lib/session'
import { safeParseColumns } from '@/lib/tool-utils'

interface RouteCtx {
  params: Promise<{ id: string }>
}

const GRANTED_ROLES = ['analyst', 'viewer'] as const
type GrantedRole = (typeof GRANTED_ROLES)[number]

/** role → table → readable columns (`null` = every column). A table absent from a role's map is denied. */
type Grants = Record<GrantedRole, Record<string, string[] | null>>

async function loadIntegration(id: string) {
  return db.integration.findFirst({ // nosemgrep
    where: { id },
    select: { id: true, name: true, accessMode: true, schemas: { select: { tableName: true, columns: true }, orderBy: { tableName: 'asc' } } },
  })
}

export async function GET(_req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const { id } = await ctx.params

    const integration = await loadIntegration(id)
    if (!integration) return NextResponse.json({ ok: false, error: 'Integration not found.' }, { status: 404 })

    const rows = await db.dataAccessPolicy.findMany({
      where: { integrationId: id },
      select: { role: true, tableName: true, allowedColumns: true },
    })
    const grants: Grants = { analyst: {}, viewer: {} }
    for (const row of rows) {
      if (!(GRANTED_ROLES as readonly string[]).includes(row.role)) continue
      grants[row.role as GrantedRole][row.tableName] = row.allowedColumns ? (JSON.parse(row.allowedColumns) as string[]) : null
    }

    return NextResponse.json({
      ok: true,
      data: {
        integrationId: integration.id,
        accessMode: integration.accessMode,
        tables: integration.schemas.map((s) => ({
          tableName: s.tableName,
          columns: safeParseColumns(s.columns).map((c) => String((c as { name: unknown }).name)),
        })),
        grants,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load the access policy.')
  }
}

/** Validate a PUT body against the reflected schema. Returns the rows to store, or an error message. */
function parseGrants(
  raw: unknown,
  schema: Map<string, Set<string>>,
): { rows: Array<{ role: GrantedRole; tableName: string; allowedColumns: string | null }> } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'grants must be an object keyed by role.' }
  const rows: Array<{ role: GrantedRole; tableName: string; allowedColumns: string | null }> = []
  for (const [role, tables] of Object.entries(raw as Record<string, unknown>)) {
    if (!(GRANTED_ROLES as readonly string[]).includes(role)) {
      return { error: `Unknown role "${role}". Grants apply to ${GRANTED_ROLES.join(' and ')}; admin is never restricted.` }
    }
    if (!tables || typeof tables !== 'object') return { error: `grants.${role} must be an object keyed by table.` }
    for (const [tableName, columns] of Object.entries(tables as Record<string, unknown>)) {
      const reflected = schema.get(tableName)
      // Only reflected tables can be granted, so a typo cannot create a grant that matches a table added later.
      if (!reflected) return { error: `Unknown table "${tableName}". Refresh the schema first if it was added recently.` }
      if (columns === null) {
        rows.push({ role: role as GrantedRole, tableName, allowedColumns: null })
        continue
      }
      if (!Array.isArray(columns) || columns.length === 0) {
        return { error: `grants.${role}.${tableName} must be null (every column) or a non-empty array of columns.` }
      }
      const unknown = columns.map(String).filter((c) => !reflected.has(c))
      if (unknown.length > 0) return { error: `Unknown column(s) on ${tableName}: ${unknown.join(', ')}.` }
      rows.push({ role: role as GrantedRole, tableName, allowedColumns: JSON.stringify([...new Set(columns.map(String))]) })
    }
  }
  return { rows }
}

export async function PUT(req: NextRequest, ctx: RouteCtx) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const { id } = await ctx.params
    const body = (await req.json().catch(() => null)) as { accessMode?: unknown; grants?: unknown } | null
    if (!body) return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 })
    if (body.accessMode !== 'open' && body.accessMode !== 'restricted') {
      return NextResponse.json({ ok: false, error: 'accessMode must be "open" or "restricted".' }, { status: 400 })
    }

    const integration = await loadIntegration(id)
    if (!integration) return NextResponse.json({ ok: false, error: 'Integration not found.' }, { status: 404 })

    const schema = new Map(
      integration.schemas.map((s) => [
        s.tableName,
        new Set(safeParseColumns(s.columns).map((c) => String((c as { name: unknown }).name))),
      ]),
    )
    const parsed = parseGrants(body.grants ?? {}, schema)
    if ('error' in parsed) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })

    // Replace, not merge: the PUT body is the whole policy, so a grant the admin removed must stop existing. Not one
    // transaction, and the order is deliberate: a failure after the delete leaves FEWER grants, never more — in
    // restricted mode that denies (fail-closed), and the admin retries the save.
    await db.dataAccessPolicy.deleteMany({ where: { integrationId: id } })
    if (parsed.rows.length > 0) {
      await db.dataAccessPolicy.createMany({
        data: parsed.rows.map((r) => ({ ...r, organizationId: user.organizationId, integrationId: id })),
      })
    }
    await db.integration.update({ where: { id: integration.id }, data: { accessMode: body.accessMode } })

    await writeAudit({
      userId: user.userId,
      action: 'ACCESS_POLICY_UPDATE',
      severity: 'warning',
      detail: {
        integrationId: id,
        before: { accessMode: integration.accessMode },
        after: {
          accessMode: body.accessMode,
          grants: parsed.rows.map((r) => `${r.role}:${r.tableName}${r.allowedColumns ? `(${(JSON.parse(r.allowedColumns) as string[]).join(',')})` : ''}`),
        },
      },
    })

    return NextResponse.json({ ok: true, data: { accessMode: body.accessMode, grantCount: parsed.rows.length } })
  } catch (e) {
    return handleApiError(e, 'Failed to update the access policy.')
  }
}
