'use client'
import { type LucideIcon } from 'lucide-react'

interface ViewHeaderProps {
  title: string
  description?: string
  icon?: LucideIcon
  action?: React.ReactNode
}

export function ViewHeader({ title, description, icon: Icon, action }: ViewHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b pb-3">
      <div className="flex items-center gap-2.5">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
        </div>
      </div>
      {action && <div>{action}</div>}
    </div>
  )
}
