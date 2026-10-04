'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { extractError } from '@/lib/extract-error'
import { useActiveUser } from '@/hooks/use-active-user'

const ROLES = ['analyst', 'viewer'] as const
type Role = (typeof ROLES)[number]
/** table → readable columns (`null` = every column). A table missing from the map is denied. */
type RoleGrants = Record<string, string[] | null>

interface PolicyData {
  accessMode: 'open' | 'restricted'
  tables: Array<{ tableName: string; columns: string[] }>
  grants: Record<Role, RoleGrants>
}

/**
 * Per-role table and column access for one integration (admin-only).
 *
 * In "open" mode every role may query every table — the behaviour of every install before per-role access. In
 * "restricted" mode analysts and viewers may query ONLY what is checked here; the server enforces it on the SQL the
 * model writes, not just in this screen. Admins are never restricted.
 */
export function AccessPolicyEditor({ integrationId }: { integrationId: string }) {
  const { user } = useActiveUser()
  const isAdmin = user?.role === 'admin'
  const [data, setData] = useState<PolicyData | null>(null)
  const [open, setOpen] = useState(false)
  const [role, setRole] = useState<Role>('viewer')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isAdmin || !open || data) return
    let cancelled = false
    fetch(`/api/integrations/${integrationId}/access-policy`)
      .then(async (res) => {
        const body = await res.json()
        if (!res.ok || !body.ok) throw new Error(extractError(body.error, 'Failed to load the access policy.'))
        if (!cancelled) setData(body.data as PolicyData)
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
    return () => {
      cancelled = true
    }
  }, [integrationId, isAdmin, open, data])

  if (!isAdmin) return null

  const grants = data?.grants[role] ?? {}

  const update = (next: RoleGrants) => setData((d) => (d ? { ...d, grants: { ...d.grants, [role]: next } } : d))

  const toggleTable = (table: string, on: boolean) => {
    const next = { ...grants }
    if (on) next[table] = null
    else delete next[table]
    update(next)
  }

  const toggleColumn = (table: string, allColumns: string[], column: string, on: boolean) => {
    const current = grants[table] === null ? allColumns : (grants[table] ?? [])
    const cols = on ? [...new Set([...current, column])] : current.filter((c) => c !== column)
    const next = { ...grants }
    if (cols.length === 0) delete next[table]
    else next[table] = cols.length === allColumns.length ? null : cols
    update(next)
  }

  const save = async () => {
    if (!data) return
    setSaving(true)
    try {
      const res = await fetch(`/api/integrations/${integrationId}/access-policy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessMode: data.accessMode, grants: data.grants }),
      })
      const body = await res.json()
      if (!res.ok || !body.ok) throw new Error(extractError(body.error, 'Failed to save the access policy.'))
      toast.success('Access policy saved.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-xs font-medium text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <ShieldCheck className="h-3.5 w-3.5" />
        Access by role
        {data && (
          <Badge variant="outline" className="ml-1 text-xs px-1.5 py-0">
            {data.accessMode}
          </Badge>
        )}
      </button>

      {open && !data && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      )}

      {open && data && (
        <div className="space-y-3 rounded-md border border-border/70 p-3">
          <label className="flex items-center justify-between gap-3 text-xs">
            <span>
              <span className="font-medium">Restrict by role</span>
              <span className="block text-muted-foreground">
                Off: every role can query every table. On: analysts and viewers can query only what is checked below.
                Admins always have full access.
              </span>
            </span>
            <Switch
              checked={data.accessMode === 'restricted'}
              onCheckedChange={(on) => setData({ ...data, accessMode: on ? 'restricted' : 'open' })}
              aria-label="Restrict access by role"
            />
          </label>

          {data.accessMode === 'restricted' && (
            <>
              <div className="flex gap-1" role="tablist" aria-label="Role">
                {ROLES.map((r) => (
                  <Button
                    key={r}
                    size="sm"
                    variant={r === role ? 'default' : 'outline'}
                    className="h-7 px-2 text-xs capitalize"
                    role="tab"
                    aria-selected={r === role}
                    onClick={() => setRole(r)}
                  >
                    {r} ({Object.keys(data.grants[r]).length})
                  </Button>
                ))}
              </div>

              <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {data.tables.map((t) => {
                  const grant = grants[t.tableName]
                  const allowed = grant !== undefined
                  const cols = grant === null ? t.columns : (grant ?? [])
                  return (
                    <li key={t.tableName} className="text-xs">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id={`grant-${role}-${t.tableName}`}
                          checked={allowed}
                          onCheckedChange={(on) => toggleTable(t.tableName, on === true)}
                        />
                        <label htmlFor={`grant-${role}-${t.tableName}`} className="flex-1 font-mono">
                          {t.tableName}
                        </label>
                        {allowed && (
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-foreground"
                            aria-expanded={expanded === t.tableName}
                            onClick={() => setExpanded(expanded === t.tableName ? null : t.tableName)}
                          >
                            {grant === null ? 'all columns' : `${cols.length}/${t.columns.length} columns`}
                          </button>
                        )}
                      </div>
                      {allowed && expanded === t.tableName && (
                        <div className="ml-6 mt-1 grid grid-cols-2 gap-1">
                          {t.columns.map((c) => (
                            <label key={c} className="flex items-center gap-1.5 font-mono">
                              <Checkbox
                                checked={cols.includes(c)}
                                onCheckedChange={(on) => toggleColumn(t.tableName, t.columns, c, on === true)}
                              />
                              {c}
                            </label>
                          ))}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          <div className="flex justify-end">
            <Button size="sm" className="h-7 px-3 text-xs" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save access policy'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
