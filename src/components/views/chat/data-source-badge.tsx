'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { TOOL_BADGE } from './types'

export function DataSourceBadge({ toolType }: { toolType: string }) {
  const meta = TOOL_BADGE[toolType]
  if (!meta) return null
  const Icon = meta.icon
  return (
    <div className="mb-1.5">
      <Badge
        variant="outline"
        className={cn('text-[10px] gap-1 py-0.5', meta.className)}
      >
        <Icon className="h-3 w-3" />
        {meta.label}
      </Badge>
     </div>
   )
 }
