'use client'

import { Fragment } from 'react'
import { Brain, Check, Loader2, Server, Sparkles, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STEP_TONE, TOOL_ICON, TOOL_SHORT } from './types'
import type { PipelineState, StepStatus } from './types'

function PipelineStep({
  label,
  icon: Icon,
  status,
}: {
  label: string
  icon: typeof Loader2
  status: StepStatus
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium whitespace-nowrap',
        STEP_TONE[status],
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      {label}
      {status === 'running' && (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      )}
      {status === 'done' && <Check className="h-3 w-3 shrink-0" />}
      {status === 'error' && <X className="h-3 w-3 shrink-0" />}
    </div>
  )
}

export function ToolPipeline({ pipeline }: { pipeline: PipelineState }) {
  const toolIcon = TOOL_ICON[pipeline.toolType] ?? Server
  const toolLabel = pipeline.toolType
    ? TOOL_SHORT[pipeline.toolType] ?? pipeline.toolType
    : 'Tool'
  const steps: { key: string; label: string; icon: typeof Loader2; status: StepStatus }[] = [
    { key: 'thinking', label: 'Analysis', icon: Brain, status: pipeline.thinking },
    { key: 'tool', label: toolLabel, icon: toolIcon, status: pipeline.tool },
    { key: 'answer', label: 'Answer', icon: Sparkles, status: pipeline.answer },
  ]
  return (
    <div className="flex items-center gap-1.5 px-3 md:px-4 py-2 bg-muted/30 overflow-x-auto">
      {steps.map((s, i) => (
        <Fragment key={s.key}>
          <PipelineStep
            label={s.label}
            icon={s.icon}
            status={s.status}
          />
          {i < steps.length - 1 && (
            <span className="text-muted-foreground/50 text-xs shrink-0">→</span>
          )}
        </Fragment>
      ))}
    </div>
  )
}
