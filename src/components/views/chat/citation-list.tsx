'use client'

import { useState } from 'react'
import { ChevronDown, Database, FileText } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { citationDetailLabel } from '@/lib/chat-layout'
import { cn } from '@/lib/utils'
import type { Citation } from '@/lib/types'

export function CitationList({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(true)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1 min-w-0 rounded-lg bg-secondary/50 p-3">
      <CollapsibleTrigger className="flex min-w-0 w-full items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">Sources ({citations.length})</span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 ml-auto transition-transform',
            open && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="min-w-0 space-y-2 mt-2">
          {citations.map((c, idx) => {
            const isDb = c.type === 'DATABASE'
            const score =
              typeof c.score === 'number' ? Math.round(c.score * 100) : null
            return (
              <div
                key={idx}
                className="min-w-0 overflow-hidden rounded-lg border bg-background/60 px-3 py-2"
              >
                <div className="grid min-w-0 gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                  <Badge
                    variant="outline"
                    className={cn(
                      'w-fit text-[10px] gap-1',
                    isDb
                      ? 'border-info/30 bg-info/15 text-info'
                      : 'border-primary/30 bg-primary/15 text-primary',
                    )}
                  >
                    {isDb ? (
                      <Database className="h-3 w-3" />
                    ) : (
                      <FileText className="h-3 w-3" />
                    )}
                    {c.type}
                  </Badge>
                  <span className="min-w-0 break-words text-xs font-medium [overflow-wrap:anywhere]">
                    {c.source}
                  </span>
                  {score !== null && (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted-foreground shrink-0"
                    >
                      relevance {score}%
                    </Badge>
                  )}
                </div>

                {c.snippet && (
                  <p className="mt-2 rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    {c.snippet}
                  </p>
                )}

                {c.query_used && c.query_used.trim().length > 0 && (
                  <details className="mt-2 group">
                    <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground select-none flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform">
                        ▸
                      </span>
                      {citationDetailLabel(c.type)}
                    </summary>
                    <pre className="mt-1.5 max-w-full rounded-md bg-muted/60 border p-2 overflow-x-auto text-[11px] font-mono leading-relaxed">
                      <code>{c.query_used}</code>
                    </pre>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
