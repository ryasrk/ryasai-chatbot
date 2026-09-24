'use client'

import type { ComponentType, ReactNode } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export type MetricIcon = ComponentType<{ className?: string }>

/**
 * The single stat tile used across every view (dashboard, schedules,
 * monitoring, integrations, knowledge). Five near-identical copies had drifted
 * apart — different value sizes, some truncating the label, some not — which is
 * why a row stopped lining up as soon as the viewport narrowed.
 *
 * Two rules keep a row symmetrical at any width:
 *  - `h-full` on the card, so every tile matches the tallest in its grid row
 *    instead of each sizing to its own content.
 *  - `items-start`, not `items-center`. Once one label wraps to two lines the
 *    whole row grows, and centred content parks each value at a different
 *    height. Top alignment keeps the numbers and icons on one line regardless.
 */
export function MetricCard({
  label,
  value,
  icon: Icon,
  iconClass,
  valueClass,
  className,
}: {
  label: string
  value: ReactNode
  icon: MetricIcon
  iconClass?: string
  valueClass?: string
  className?: string
}) {
  return (
    <Card className={cn('h-full', className)}>
      <CardContent className="flex h-full items-start justify-between gap-2">
        <div className="min-w-0">
          <div className={cn('text-lg font-semibold tabular-nums leading-tight', valueClass)}>
            {value}
          </div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
        <Icon className={cn('h-4 w-4 shrink-0', iconClass)} />
      </CardContent>
    </Card>
  )
}
