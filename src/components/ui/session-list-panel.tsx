'use client'

import {
  Plus, Loader2, Trash2, PanelLeftOpen, PanelLeftClose, Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { formatDistanceToNow } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { Delayed, SessionListSkeleton } from '@/components/ui/view-states'

export interface SessionListItem {
  id: string
  title: string
  createdAt: string
  updatedAt?: string
  _count?: { messages: number }
}

export function SessionListPanel({
  sessions,
  activeId,
  loading,
  onSelect,
  onNew,
  onDelete,
  deletingId,
  collapsed = false,
  onCollapsedChange,
  title = 'Sessions',
  emptyHint = 'No sessions yet.',
}: {
  sessions: SessionListItem[]
  activeId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  deletingId?: string | null
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  title?: string
  emptyHint?: string
}) {
  const expanded = !collapsed
  const canCollapse = !!onCollapsedChange
  const setExpanded = (next: boolean | ((value: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(expanded) : next
    onCollapsedChange?.(!value)
  }

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center gap-1.5 py-2">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-[background-color,color,transform] duration-200 hover:translate-x-0.5 hover:bg-muted hover:text-foreground"
          aria-label={`Buka daftar ${title.toLowerCase()}`}
          aria-expanded={false}
        >
          <PanelLeftOpen className="h-3.5 w-3.5" />
        </button>
        <Button
          onClick={onNew}
          size="icon"
          variant="default"
          className="h-8 w-8"
          aria-label={`${title} baru`}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b">
        <button
          type="button"
          onClick={() => canCollapse && setExpanded((v) => !v)}
          className={cn(
            'group flex w-full items-center justify-between gap-1.5 px-2.5 py-2 text-left transition-[background-color,color] duration-200',
            canCollapse && 'hover:bg-muted/70',
          )}
          aria-expanded={expanded}
        >
          <div className="min-w-0">
            <div className="text-xs font-medium">{title}</div>
            {expanded && (
              <div className="text-[10px] text-muted-foreground">
                {sessions.length} sessions
              </div>
            )}
          </div>
          {canCollapse && (
            <PanelLeftClose className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 group-hover:-translate-x-0.5" />
          )}
        </button>
      </div>

      <div className="p-2 border-b">
        <Button
          onClick={onNew}
          size="sm"
          className="w-full h-7 text-[11px]"
          variant="ghost"
        >
          <Plus className="h-3 w-3" />
          {title} Baru
        </Button>
      </div>

      {expanded ? (
        <ScrollArea className="flex-1 min-h-0">
          <div className="p-1.5 space-y-0.5">
            {loading ? (
              <Delayed><SessionListSkeleton /></Delayed>
            ) : sessions.length === 0 ? (
              <div className="text-center py-6 text-[11px] text-muted-foreground">
                {emptyHint}
              </div>
            ) : (
              sessions.map((s) => {
                const active = s.id === activeId
                const deleting = deletingId === s.id
                return (
                  <div
                    key={s.id}
                    className={cn(
                      'group relative rounded-lg px-2 py-1.5 cursor-pointer transition-colors',
                      active
                        ? 'bg-primary/10'
                        : 'hover:bg-hover',
                    )}
                    onClick={() => onSelect(s.id)}
                  >
                    {active && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 h-8 w-1 rounded-r bg-primary" />
                    )}
                    <div className="flex items-start gap-1.5">
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn(
                            'line-clamp-2 break-words text-[11px] font-medium leading-tight',
                            active ? 'text-primary' : 'text-foreground',
                          )}
                        >
                          {s.title || 'Tanpa Judul'}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {formatDistanceToNow(new Date(s.updatedAt ?? s.createdAt), {
                            addSuffix: false,
                            locale: idLocale,
                          })}{' '}
                          lalu
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            window.open(`/api/sessions/${s.id}/export?format=markdown`, '_blank')
                          }}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                          aria-label="Export session"
                        >
                          <Download className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onDelete(s.id)
                          }}
                          disabled={deleting}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 disabled:opacity-50"
                          aria-label="Delete session"
                        >
                          {deleting ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>
      ) : (
        <div className="flex-1 min-h-0 px-2.5 py-3 text-[11px] text-muted-foreground">
          Klik header untuk membuka.
        </div>
      )}
    </div>
  )
}
