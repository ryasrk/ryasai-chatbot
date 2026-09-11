'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Key,
  Table2,
  Copy,
  Code2,
  Download,
  Search,
  Columns3,
  ChevronsDownUp,
  ChevronsUpDown,
  ShieldAlert,
  Pencil,
  Lock,
  Unlock,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Accordion,
  AccordionContent,
  AccordionTrigger,
  AccordionItem,
} from '@/components/ui/accordion'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Delayed, TableSkeleton } from '@/components/ui/view-states'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Separator } from '@/components/ui/separator'
import { extractError } from '@/lib/extract-error'
import { useActiveUser } from '@/hooks/use-active-user'
import { PromptEditor } from '@/components/views/_shared/prompt-editor'
import type { Integration } from '@/lib/types'
import { SchemaData, SchemaTable, timeAgo } from './types'

// Char caps match the server-side limits (spec §API).
const INTEGRATION_PROMPT_MAX = 4000
// ponytail: must match the API cap (SCHEMA_DESC_MAX in the schema PATCH route).
const TABLE_DESCRIPTION_MAX = 500

function generateCreateTable(table: SchemaTable): string {
  const cols = table.columns.map((c) => {
    let line = `  "${c.name}" ${c.type || 'TEXT'}`
    if (c.primaryKey) line += ' PRIMARY KEY'
    if (c.nullable === false) line += ' NOT NULL'
    return line
  })
  return `CREATE TABLE "${table.tableName}" (\n${cols.join(',\n')}\n);`
}

function SchemaIconAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-muted cursor-pointer transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation()
              e.preventDefault()
              onClick()
            }
          }}
        >
          <Icon className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function SchemaTableDetails({
  table,
  columnSearch,
  integrationId,
}: {
  table: SchemaTable
  columnSearch: string
  integrationId: string
}) {
  const colQ = columnSearch.trim().toLowerCase()
  const hasColMatch = colQ.length > 0
  const hasDescriptions = table.columns.some((c) => c.description)

  return (
    <div className="space-y-3">
      {/* Table description editor — admin-only. Rendered above columns. */}
      <TableDescriptionEditor
        integrationId={integrationId}
        tableName={table.tableName}
        description={table.description ?? ''}
        manual={table.manualDescription === true}
      />

      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
          Columns
        </h4>
        <div className="rounded-none border border-border/60 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-7 text-xs">Name</TableHead>
                <TableHead className="h-7 text-xs">Type</TableHead>
                <TableHead className="h-7 text-xs w-16">Null</TableHead>
                <TableHead className="h-7 text-xs w-10">PK</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.columns.map((c, i) => {
                const isMatch =
                  hasColMatch && c.name.toLowerCase().includes(colQ)
                return (
                  <TableRow
                    key={i}
                    className={isMatch ? 'bg-primary/10' : undefined}
                  >
                    <TableCell className="py-1.5 text-xs font-mono">
                      <div className="flex items-center gap-1.5">
                        {c.primaryKey && (
                          <Key className="h-3 w-3 text-warning shrink-0" />
                        )}
                        <span>{c.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="py-1.5">
                      <Badge
                        variant="outline"
                        className="text-xs px-1.5 py-0 font-mono"
                      >
                        {c.type || '-'}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-1.5">
                      {c.nullable !== undefined ? (
                        <Badge
                          variant={c.nullable ? 'secondary' : 'destructive'}
                          className="text-xs px-1.5 py-0"
                        >
                          {c.nullable ? 'YES' : 'NO'}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-1.5">
                      {c.primaryKey ? (
                        <Key className="h-3 w-3 text-warning" />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
        {hasDescriptions && (
          <div className="mt-1.5 space-y-0.5">
            {table.columns
              .filter((c) => c.description)
              .map((c, i) => (
                <div
                  key={i}
                  className="text-xs text-muted-foreground"
                >
                  <span className="font-mono">{c.name}</span>: {c.description}
                </div>
              ))}
          </div>
        )}
      </div>

      {table.sampleData && table.sampleData.length > 0 && (
        <>
          <Separator />
          <div>
            <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
              Sample Data ({table.sampleData.length} rows)
            </h4>
            <div className="rounded-none border border-border/60 overflow-auto max-h-32">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    {Object.keys(table.sampleData[0]).map((k) => (
                      <TableHead
                        key={k}
                        className="h-6 text-xs font-mono whitespace-nowrap"
                      >
                        {k}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {table.sampleData.map((row, i) => (
                    <TableRow key={i}>
                      {Object.values(row).map((v, j) => (
                        <TableCell
                          key={j}
                          className="py-1 text-xs font-mono whitespace-nowrap"
                        >
                          {v === null || v === undefined ? '—' : String(v)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}

      <Separator />
      <div>
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
          Metadata
        </h4>
        <div className="space-y-0.5 text-xs">
          <div className="flex gap-2">
            <span className="text-muted-foreground w-28">Row count</span>
            <span className="font-mono">{table.rowCount ?? '?'}</span>
          </div>
          <div className="flex gap-2">
            <span className="text-muted-foreground w-28">Reflected</span>
            <span>{timeAgo(table.reflectedAt)}</span>
          </div>
          {table.metadata &&
            Object.entries(table.metadata).map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="text-muted-foreground w-28">{k}</span>
                <span className="font-mono">{String(v)}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Per-table description editor — admin-only. Shows the current description
 * with a "manual" lock badge when `manualDescription` is true (the enrichment
 * step skips manual rows). Editing sends PATCH /api/integrations/{id}/schema
 * `{ table, description }`; "Reset to auto" sends `description: null` to clear
 * the manual lock and mark the row for re-enrichment.
 *
 * NOTE: the schema GET route does not currently return `description` or
 * `manualDescription` (agent B's route extension is not in this working tree),
 * so the editor starts empty until the GET is extended. Saving still works
 * once agent B adds the PATCH handler.
 */
function TableDescriptionEditor({
  integrationId,
  tableName,
  description,
  manual,
}: {
  integrationId: string
  tableName: string
  description: string
  manual: boolean
}) {
  const { user } = useActiveUser()
  const isAdmin = user?.role === 'admin'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(description)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(description)
  }, [description])

  const save = async (value: string | null) => {
    setSaving(true)
    try {
      const res = await fetch(`/api/integrations/${integrationId}/schema`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ table: tableName, description: value }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        toast.error(extractError(json?.error, 'Failed to save table description.'))
        return
      }
      setDraft(value ?? '')
      toast.success(
        value === null
          ? 'Reset to auto. The table will be re-enriched on next refresh.'
          : 'Table description saved',
      )
      setEditing(false)
    } catch {
      toast.error('Network error while saving table description.')
    } finally {
      setSaving(false)
    }
  }

  if (!isAdmin) {
    // Non-admins: read-only view of the description (no edit affordance).
    return description ? (
      <div className="text-xs text-muted-foreground italic">&ldquo;{description}&rdquo;</div>
    ) : null
  }

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Description</span>
            {manual ? (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
                <Lock className="h-2.5 w-2.5" /> manual
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
                <Unlock className="h-2.5 w-2.5" /> auto
              </Badge>
            )}
          </div>
          {description ? (
            <p className="text-xs text-foreground/80 mt-0.5 break-words">{description}</p>
          ) : (
            <p className="text-xs text-muted-foreground italic mt-0.5">No description yet.</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => { setDraft(description); setEditing(true) }}
            icon={<Pencil className="h-3 w-3" />}
          >
            Edit
          </Button>
          {manual && (
            <button
              type="button"
              onClick={() => save(null)}
              disabled={saving}
              className="text-xs text-primary hover:underline disabled:opacity-50"
            >
              {saving ? 'Resetting…' : 'Reset to auto'}
            </button>
          )}
        </div>
      </div>
    )
  }

  // Inline editor
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Description for {tableName}</span>
        <span className="text-[10px] font-mono tabular-nums text-muted-foreground">
          {draft.length}/{TABLE_DESCRIPTION_MAX}
        </span>
      </div>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, TABLE_DESCRIPTION_MAX))}
        rows={3}
        className="resize-y text-xs"
        placeholder="Describe what this table holds, in plain language. Used by Text-to-SQL."
        disabled={saving}
      />
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={() => save(draft.trim())}
          disabled={saving || draft.trim().length === 0}
          icon={saving ? <Loader2 className="h-3 w-3 animate-spin" /> : undefined}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => { setDraft(description); setEditing(false) }}
          disabled={saving}
        >
          Cancel
        </Button>
        {manual && (
          <button
            type="button"
            onClick={() => save(null)}
            disabled={saving}
            className="text-xs text-primary hover:underline disabled:opacity-50 ml-auto"
          >
            Reset to auto
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Integration-level context prompt editor — admin-only. Persists via
 * PATCH /api/integrations/{id} { contextPrompt }.
 */
function IntegrationContextPromptEditor({
  integrationId,
  initial,
}: {
  integrationId: string
  initial: string
}) {
  const { user } = useActiveUser()
  const isAdmin = user?.role === 'admin'

  if (!isAdmin) {
    return (
      <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 space-y-1">
        <div className="text-xs font-medium flex items-center gap-1.5">
          <Lock className="h-3 w-3 text-muted-foreground" />
          Context Prompt
        </div>
        <p className="text-xs text-muted-foreground">Read-only. Ask an admin to edit the per-integration context prompt.</p>
      </div>
    )
  }

  return (
    <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="text-xs font-medium">Context Prompt</div>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">per-integration</Badge>
      </div>
      <PromptEditor
        id="integration-context-prompt"
        value={initial}
        onSave={async (next) => {
          try {
            const res = await fetch(`/api/integrations/${integrationId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contextPrompt: next }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok || !json.ok) {
              return { ok: false, error: json?.error ?? 'Failed to save context prompt.' }
            }
            const persisted: string | undefined = json.data?.contextPrompt ?? next
            toast.success('Context prompt saved')
            return { ok: true, value: persisted }
          } catch (e) {
            return { ok: false, error: e }
          }
        }}
        maxLength={INTEGRATION_PROMPT_MAX}
        placeholder="Optional guidance injected into SQL generation for this integration. Empty injects nothing."
        helperText="Where injected: SQL synthesis + final answer prose for this integration."
      />
    </div>
  )
}

export function SchemaViewerSheet({
  integration,
  onClose,
}: {
  integration: Integration | null
  onClose: () => void
}) {
  return (
    <Sheet open={!!integration} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-[720px] w-full flex flex-col">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Table2 className="h-4 w-4" />
            Schema {integration?.name ?? ''}
          </SheetTitle>
          <SheetDescription>
            Cached table &amp; column reflection from the integration.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 min-h-0 mt-2">
          {integration && (
            <SchemaViewerContent
              key={integration.id}
              integration={integration}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SchemaViewerContent({
  integration,
}: {
  integration: Integration
}) {
  const [data, setData] = useState<SchemaData | null>(null)
  // Integration-level context prompt — fetched from the integration detail
  // endpoint (agent B extends it to return `contextPrompt`). Default '' until
  // then; saving still works once the PATCH route accepts the field.
  const [contextPrompt, setContextPrompt] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tableSearch, setTableSearch] = useState('')
  const [columnSearch, setColumnSearch] = useState('')
  const [openItems, setOpenItems] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/integrations/${integration.id}/schema`, { cache: 'no-store' }),
      fetch(`/api/integrations/${integration.id}`, { cache: 'no-store' }),
    ])
      .then(async ([schemaRes, detailRes]) => {
        const sj = await schemaRes.json()
        if (cancelled) return
        if (schemaRes.ok && sj.ok) setData(sj.data as SchemaData)
        else setError(extractError(sj.error, 'Failed to load schema.'))
        if (detailRes.ok) {
          const dj = await detailRes.json()
          if (!cancelled && dj?.data?.contextPrompt !== undefined) {
            setContextPrompt(String(dj.data.contextPrompt ?? ''))
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError('Network error while loading schema.')
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [integration.id])

  const filteredTables = useMemo(() => {
    if (!data) return []
    const q = tableSearch.trim().toLowerCase()
    const colQ = columnSearch.trim().toLowerCase()
    return data.tables.filter((t) => {
      if (q && !t.tableName.toLowerCase().includes(q)) return false
      if (
        colQ &&
        !t.columns.some((c) => c.name.toLowerCase().includes(colQ))
      )
        return false
      return true
    })
  }, [data, tableSearch, columnSearch])

  const allIds = useMemo(
    () => filteredTables.map((t) => t.id),
    [filteredTables],
  )
  const allOpen =
    allIds.length > 0 && allIds.every((id) => openItems.includes(id))

  const handleExpandAll = () => setOpenItems(allIds)
  const handleCollapseAll = () => setOpenItems([])

  const handleDownload = () => {
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `schema-${data.name}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleCopyName = async (name: string) => {
    try { await navigator.clipboard.writeText(name); toast.success('Table name copied') } catch { toast.error('Failed to copy') }
  }

  const handleCopyCreateTable = async (table: SchemaTable) => {
    try { await navigator.clipboard.writeText(generateCreateTable(table)); toast.success('CREATE TABLE schema copied') } catch { toast.error('Failed to copy') }
  }

  if (loading) {
    return <Delayed><TableSkeleton rows={8} cols={3} /></Delayed>
  }
  if (error) {
    return (
      <Alert variant="destructive">
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>Failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }
  if (!data) {
    return (
      <div className="text-xs text-muted-foreground py-8 text-center">
        No data.
      </div>
    )
  }
  if (data.tables.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-8 text-center">
        Schema is empty. Run <strong>Test Connection</strong> to
        reflect tables.
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Integration context prompt — admin-only. */}
      <div className="pb-2.5 border-b border-border/70">
        <IntegrationContextPromptEditor
          integrationId={integration.id}
          initial={contextPrompt}
        />
      </div>
      <div className="space-y-2 pb-2.5 border-b border-border/70">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {filteredTables.length} of {data.tableCount} tables ·{' '}
            <Badge
              variant="outline"
              className="text-xs px-1.5 py-0"
            >
              {data.provider}
            </Badge>
          </span>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                  icon={
                    allOpen ? (
                      <ChevronsDownUp className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    )
                  }
                  onClick={allOpen ? handleCollapseAll : handleExpandAll}
                >
                  {allOpen ? 'Collapse' : 'Expand'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {allOpen ? 'Collapse all tables' : 'Expand all tables'}
              </TooltipContent>
            </Tooltip>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs gap-1"
              icon={<Download className="h-3.5 w-3.5" />}
              onClick={handleDownload}
            >
              JSON
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search tables…"
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <div className="relative flex-1">
            <Columns3 className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search columns…"
              value={columnSearch}
              onChange={(e) => setColumnSearch(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0 mt-2 pr-2">
        {filteredTables.length === 0 ? (
          <div className="text-xs text-muted-foreground py-8 text-center">
            No matching tables.
          </div>
        ) : (
          <Accordion
            type="multiple"
            value={openItems}
            onValueChange={setOpenItems}
            className="w-full space-y-2"
          >
            {filteredTables.map((t) => (
              <AccordionItem
                key={t.id}
                value={t.id}
                className="rounded-none border border-border/70 bg-card/50 overflow-hidden"
              >
                <div className="flex items-center gap-1 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <AccordionTrigger className="py-0 px-0 hover:no-underline">
                      <div className="flex items-center gap-2 min-w-0">
                        <Table2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-mono text-sm font-medium truncate">
                          {t.tableName}
                        </span>
                        <Badge
                          variant="secondary"
                          className="text-xs px-1.5 py-0 shrink-0"
                        >
                          {t.rowCount ?? '?'} rows
                        </Badge>
                        <Badge
                          variant="outline"
                          className="text-xs px-1.5 py-0 shrink-0"
                        >
                          {t.columns.length} columns
                        </Badge>
                      </div>
                    </AccordionTrigger>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <SchemaIconAction
                      icon={Copy}
                      label="Copy table name"
                      onClick={() => handleCopyName(t.tableName)}
                    />
                    <SchemaIconAction
                      icon={Code2}
                      label="Copy CREATE TABLE"
                      onClick={() => handleCopyCreateTable(t)}
                    />
                  </div>
                </div>
                <AccordionContent className="px-3 pb-3">
                  <SchemaTableDetails
                    table={t}
                    columnSearch={columnSearch}
                    integrationId={integration.id}
                  />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </ScrollArea>
    </div>
  )
}
