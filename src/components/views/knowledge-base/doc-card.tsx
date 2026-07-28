'use client'

import { useState } from 'react'
import { Eye, Trash2, Loader2 } from 'lucide-react'
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
  const { Icon, className: iconCls } = fileIconFor(doc.type)
  const status = STATUS_BADGE[doc.status] ?? STATUS_BADGE.error
  const catBadge = categoryColor(doc.category ?? 'Uncategorized')
  const isEnabled = doc.isEnabled !== false

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
              {doc.name}
            </CardTitle>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={cn('text-[10px]', catBadge)}>
                {doc.category ?? 'Uncategorized'}
              </Badge>
              <Badge variant="outline" className={cn('text-[10px]', status.className)}>
                {status.label}
              </Badge>
              {doc.cognifyStatus && (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px]',
                    doc.cognifyStatus === 'completed' && 'bg-primary/15 text-primary border-primary/20',
                    doc.cognifyStatus === 'processing' && 'bg-warning/15 text-warning border-warning/20',
                    doc.cognifyStatus === 'failed' && 'bg-destructive/15 text-destructive border-destructive/20',
                  )}
                >
                  {doc.cognifyStatus === 'completed' ? 'Graph' : doc.cognifyStatus}
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
        <div className="mt-auto grid grid-cols-2 gap-2">
          <Button size="sm" variant="outline" onClick={onDetail} className="text-xs h-7">
            <Eye className="h-3 w-3" />
            Details
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            disabled={deleting}
            className="text-xs h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
          >
            {deleting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            {deleting ? 'Deleting' : 'Delete'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
