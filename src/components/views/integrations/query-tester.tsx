'use client'

import { useState } from 'react'
import { Terminal, Loader2, ShieldAlert, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { extractError } from '@/lib/extract-error'
import type { Integration, QueryResult } from '@/lib/types'

const SAMPLE_QUERY = 'Show 5 products with the highest price'

export function QueryTesterDialog({
  integration,
  onClose,
}: {
  integration: Integration | null
  onClose: () => void
}) {
  return (
    <Dialog open={!!integration} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[760px] max-h-[92vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            Query Tester — {integration?.name ?? ''}
          </DialogTitle>
          <DialogDescription>
            Ask a natural language question. The system will convert it to SQL,
            validate via AST guardrail, then execute it.
          </DialogDescription>
        </DialogHeader>
        {integration && (
          <QueryTesterContent key={integration.id} integration={integration} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function QueryTesterContent({ integration }: { integration: Integration }) {
  const [query, setQuery] = useState(SAMPLE_QUERY)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleRun = async () => {
    const q = query.trim()
    if (!q) {
      toast.error('Question cannot be empty.')
      return
    }
    setRunning(true)
    setResult(null)
    setErrorMsg(null)
    try {
      const res = await fetch(`/api/integrations/${integration.id}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ naturalQuery: q }),
      })
      const json = (await res.json()) as QueryResult & {
        error?: string
        reason?: string
        generatedSql?: string
      }
      if (res.ok && json.ok) {
        setResult(json)
      } else if (res.status === 403) {
        // guardrail block — keep the result shape so UI can render it
        setResult({
          ok: false,
          reason: json.reason ?? 'Query rejected by security guardrail.',
          generatedSql: json.generatedSql,
        })
      } else {
        setErrorMsg(
          extractError(
            json.error,
            json.reason ??
              'Sorry, an error occurred while processing the query.',
          ),
        )
      }
    } catch (e) {
      console.error(e)
      setErrorMsg('Network error while running the query.')
    } finally {
      setRunning(false)
    }
  }

  const rows = result?.rows ?? []
  const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : []

  return (
        <div className="space-y-3 min-h-0 flex-1 overflow-y-auto pr-1">
           <div className="space-y-1.5">
             <Label htmlFor="nlq">Question (Natural Language)</Label>
             <Textarea
               id="nlq"
               value={query}
               onChange={(e) => setQuery(e.target.value)}
               rows={3}
               placeholder={SAMPLE_QUERY}
               className="resize-none"
             />
           </div>

           <div className="flex items-center justify-between gap-2">
             <p className="text-xs text-muted-foreground">
               Pre-fill: example query. Edit as needed.
             </p>
             <Button onClick={handleRun} disabled={running || !query.trim()}>
               {running ? (
                 <>
                   <Loader2 className="h-4 w-4 animate-spin" />
                   Running…
                 </>
               ) : (
                 <>
                   <Terminal className="h-4 w-4" />
                   Run
                 </>
               )}
             </Button>
           </div>

           {/* Guardrail block */}
           {result && !result.ok && result.reason && (
             <Alert variant="destructive">
               <ShieldAlert className="h-4 w-4" />
               <AlertTitle>Query Rejected by Guardrail</AlertTitle>
               <AlertDescription className="space-y-1">
                 <p>{result.reason}</p>
                 {result.generatedSql && (
                   <pre className="mt-2 text-xs bg-rose-950/20 dark:bg-rose-950/40 rounded-md p-2 overflow-x-auto">
                     <code>{result.generatedSql}</code>
                   </pre>
                 )}
               </AlertDescription>
             </Alert>
           )}

           {/* Generic error */}
           {errorMsg && (
             <Alert variant="destructive">
               <ShieldAlert className="h-4 w-4" />
               <AlertTitle>An Error Occurred</AlertTitle>
               <AlertDescription>{errorMsg}</AlertDescription>
             </Alert>
           )}

           {/* Success result */}
           {result && result.ok && (
             <div className="space-y-3">
               <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                 <div className="flex items-center justify-between gap-2 flex-wrap">
                   <div className="flex items-center gap-1.5 text-xs font-medium">
                     <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                     Generated SQL
                   </div>
                   <div className="flex items-center gap-2 text-xs text-muted-foreground">
                     <Badge variant="secondary" className="text-xs">
                       {result.rowCount ?? 0} rows
                     </Badge>
                     <Badge variant="secondary" className="text-xs">
                       {result.executionMs ?? 0} ms
                     </Badge>
                   </div>
                 </div>
                 <pre className="text-xs bg-background border rounded-md p-2 overflow-x-auto">
                   <code>{result.sql}</code>
                 </pre>
                 {result.explanation && (
                   <p className="text-xs text-muted-foreground">
                     {result.explanation}
                   </p>
                 )}
               </div>

               {rows.length > 0 ? (
                 <div className="rounded-md border overflow-hidden">
                   <div className="max-h-[320px] overflow-auto">
                     <Table>
                       <TableHeader className="sticky top-0 bg-background z-10">
                         <TableRow>
                           {columns.map((c) => (
                             <TableHead
                               key={c}
                               className="text-xs font-mono whitespace-nowrap"
                             >
                               {c}
                             </TableHead>
                           ))}
                         </TableRow>
                       </TableHeader>
                       <TableBody>
                         {rows.map((r, i) => (
                           <TableRow key={i}>
                             {columns.map((c) => (
                               <TableCell
                                 key={c}
                                 className="text-xs font-mono whitespace-nowrap"
                               >
                                 {formatCell((r as Record<string, unknown>)[c])}
                               </TableCell>
                             ))}
                           </TableRow>
                         ))}
                       </TableBody>
                     </Table>
                   </div>
                 </div>
               ) : (
                 <p className="text-xs text-muted-foreground italic">
                   Query executed successfully but returned no rows.
                 </p>
               )}
             </div>
           )}
         </div>
  )
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}
