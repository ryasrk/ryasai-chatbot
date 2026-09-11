'use client'

import { useEffect, useRef, useState } from 'react'
import { Eye, Trash2, Loader2, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { DocumentItem } from '@/lib/types'
import { fileIconFor, STATUS_BADGE, categoryColor } from './helpers'

export function DocCard({
  doc,
  deleting,
  onDetail,
  onDelete,
  onToggle,
}: {
  doc: DocumentItem
  deleting?: boolean
  onDetail: () => void
  onDelete: () => void
  onToggle: (checked: boolean) => void
}) {
  const [toggling, setToggling] = useState(false)
  const [retrying, setRetrying] = useState(false)
  // Local status override after a reprocess — the card shows Processing
  // immediately, then the poll refreshes it with the server's answer.
  const [override, setOverride] = useState<{ status?: string; cognifyStatus?: string | null }>({})
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current)
    }
  }, [])

  const isFailed = doc.status === 'error' || doc.cognifyStatus === 'failed'
  const effectiveDoc: DocumentItem = {
    ...doc,
    status: override.status ?? doc.status,
    cognifyStatus: override.cognifyStatus !== undefined ? override.cognifyStatus : doc.cognifyStatus,
  }

  async function handleRetry() {
    if (retrying) return
    setRetrying(true)
    try {
      const res = await fetch(`/api/documents/${doc.id}/reprocess`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        console.error(body?.error ?? 'Reprocess failed.')
        return
      }
      setOverride({ status: 'ready', cognifyStatus: 'processing' })
      // ponytail: one delayed refresh so the card reflects the job outcome
      // without wiring a parent-level refetch (the card is self-contained).
      pollTimer.current = setTimeout(async () => {
        try {
          const detail = await fetch(`/api/documents/${doc.id}`)
          if (!detail.ok) return
          const data = (await detail.json()) as {
            document?: { status?: string; cognifyStatus?: string | null }
          }
          if (data.document) {
            setOverride({
              status: data.document.status,
              cognifyStatus: data.document.cognifyStatus ?? null,
            })
          }
        } catch {
          // keep the optimistic state; the list refetch will correct it
        }
      }, 8_000)
    } finally {
      setRetrying(false)
    }
  }

  const { Icon, className: iconCls } = fileIconFor(effectiveDoc.type)
  const status = STATUS_BADGE[effectiveDoc.status] ?? STATUS_BADGE.error
  const catBadge = categoryColor(effectiveDoc.category ?? 'Uncategorized')
  const isEnabled = effectiveDoc.isEnabled !== false

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-start gap-2.5">
          <div
            className={cn(
              'h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
              iconCls,
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-xs leading-snug break-words line-clamp-1">
              {effectiveDoc.name}
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={cn('text-[10px]', catBadge)}>
                {effectiveDoc.category ?? 'Uncategorized'}
              </Badge>
              <Badge variant="outline" className={cn('text-[10px]', status.className)}>
                {status.label}
              </Badge>
              {effectiveDoc.cognifyStatus && (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px]',
                    effectiveDoc.cognifyStatus === 'completed' && 'bg-primary/15 text-primary border-primary/20',
                    effectiveDoc.cognifyStatus === 'processing' && 'bg-warning/15 text-warning border-warning/20',
                    effectiveDoc.cognifyStatus === 'failed' && 'bg-destructive/15 text-destructive border-destructive/20',
                  )}
                >
                  {effectiveDoc.cognifyStatus === 'completed' ? 'Graph' : effectiveDoc.cognifyStatus}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-medium text-muted-foreground">
              {isEnabled ? 'ON' : 'OFF'}
            </span>
            <Switch
              checked={isEnabled}
              disabled={toggling}
              onCheckedChange={async (checked) => {
                setToggling(true)
                try {
                  await onToggle(checked)
                } finally {
                  setToggling(false)
                }
              }}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-2 pt-0">
        {isFailed && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleRetry}
            disabled={retrying}
            className="w-full text-xs h-7 col-span-2"
            icon={retrying ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
          >
            {retrying ? 'Queuing' : 'Retry Processing'}
          </Button>
        )}
        <div className="mt-auto grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onDetail}
            className="text-xs h-7"
            icon={<Eye className="h-3 w-3" />}
          >
            Details
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
            icon={deleting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
          >
            {deleting ? 'Deleting' : 'Delete'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
