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
import { TableSkeleton } from '@/components/ui/view-states'
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
import type { Integration } from '@/lib/types'
import { SchemaData, SchemaTable, timeAgo } from './types'

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
}: {
  table: SchemaTable
  columnSearch: string
}) {
  const colQ = columnSearch.trim().toLowerCase()
  const hasColMatch = colQ.length > 0
  const hasDescriptions = table.columns.some((c) => c.description)

  return (
    <div className="space-y-3">
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tableSearch, setTableSearch] = useState('')
  const [columnSearch, setColumnSearch] = useState('')
  const [openItems, setOpenItems] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    fetch(`/api/integrations/${integration.id}/schema`, { cache: 'no-store' })
      .then(async (r) => {
        const j = await r.json()
        if (cancelled) return
        if (r.ok && j.ok) setData(j.data as SchemaData)
        else setError(extractError(j.error, 'Failed to load schema.'))
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
    return <TableSkeleton rows={8} cols={3} />
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
                  onClick={allOpen ? handleCollapseAll : handleExpandAll}
                >
                  {allOpen ? (
                    <ChevronsDownUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronsUpDown className="h-3.5 w-3.5" />
                  )}
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
              onClick={handleDownload}
            >
              <Download className="h-3.5 w-3.5" />
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
