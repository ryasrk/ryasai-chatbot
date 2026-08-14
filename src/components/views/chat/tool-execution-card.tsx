'use client'

import { Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TOOL_ICON, TOOL_META, TOOL_SHORT } from './types'
import type { StepStatus } from './types'

export function ToolExecutionCard({
  toolType,
  status,
  startedAt,
}: {
  toolType: string
  status: StepStatus
  startedAt: number | null
}) {
  const Icon = TOOL_ICON[toolType] ?? Server
  const name = TOOL_SHORT[toolType] ?? toolType
  const desc = TOOL_META[toolType]?.label ?? `Running ${toolType}...`
  const borderTone =
    status === 'running'
      ? 'border-info/60'
      : status === 'done'
        ? 'border-success/60'
        : status === 'error'
          ? 'border-destructive/60'
          : 'border-border'
  const badgeTone =
    status === 'running'
      ? 'bg-info/15 text-info'
      : status === 'done'
        ? 'bg-success/15 text-success'
        : status === 'error'
          ? 'bg-destructive/15 text-destructive'
          : 'bg-muted text-muted-foreground'
  const badgeText =
    status === 'running'
      ? 'Running'
      : status === 'done'
        ? 'Success'
        : status === 'error'
          ? 'Failed'
          : 'Pending'
  return (
    <div
      className={cn(
        'rounded-sm border p-3.5 bg-muted flex items-start gap-3',
        borderTone,
      )}
    >
      <div className="shrink-0 mt-0.5">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-foreground">{name}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px] font-medium',
            badgeTone,
          )}
        >
          {badgeText}
        </span>
        {startedAt && (
          <span className="text-[10px] text-muted-foreground">
            {new Date(startedAt).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </span>
        )}
      </div>
    </div>
  )
}
