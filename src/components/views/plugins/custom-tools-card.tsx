'use client'

import { createElement } from 'react'
import {
  Puzzle,
  Play,
  Pencil,
  Trash2,
  Database,
  Globe,
  Activity,
  Lock,
  Zap,
} from 'lucide-react'

import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

import type { PluginRow } from './types'
import { TogglePopup } from './toggle-popup'

const CATEGORY_ICONS: Record<string, typeof Puzzle> = {
  general: Puzzle,
  database: Database,
  api: Globe,
  monitoring: Activity,
  security: Lock,
  productivity: Zap,
}

function iconForCategory(cat: string | undefined) {
  return CATEGORY_ICONS[cat ?? 'general'] ?? Puzzle
}

interface CardProps {
  plugin: PluginRow
  toggling: boolean
  onToggle: () => void
  onContextChange: (chat: boolean, agentic: boolean) => void
  onTest: () => void
  onEdit: () => void
  onDelete: () => void
}

export function CustomToolCard({
  plugin: p,
  toggling,
  onToggle,
  onContextChange,
  onTest,
  onEdit,
  onDelete,
}: CardProps) {
  return (
    <Card key={p.id} className="rounded-lg border p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
            {createElement(iconForCategory(p.category), { className: 'h-4 w-4 text-primary' })}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{p.name}</p>
            <code className="font-mono text-xs text-muted-foreground">
              plugin:{p.toolId}
            </code>
          </div>
        </div>
        <TogglePopup
          isEnabled={p.isEnabled}
          chatEnabled={p.chatEnabled}
          agenticEnabled={p.agenticEnabled}
          disabled={toggling}
          onToggle={onToggle}
          onContextChange={onContextChange}
        />
      </div>

      <p className="text-xs text-muted-foreground line-clamp-2 min-h-[2.5rem]">
        {p.description || 'No description'}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {p.manifest?.method && (
          <Badge
            className={
              'text-xs shrink-0 ' +
              (p.manifest.method === 'GET'
                ? 'bg-info/15 text-info border-info/20'
                : 'bg-primary/15 text-primary border-primary/20')
            }
          >
            {p.manifest.method}
          </Badge>
        )}
        {p.category && (
          <Badge variant="secondary" className="text-xs capitalize shrink-0">
            {p.category}
          </Badge>
        )}
        {p.isEnabled ? (
          <Badge className="text-xs bg-success/15 text-success border-success/20 shrink-0">
            Active
          </Badge>
        ) : (
          <Badge variant="secondary" className="text-xs shrink-0">Off</Badge>
        )}
      </div>

      {p.manifest?.endpoint && (
        <code className="font-mono text-xs text-muted-foreground truncate block">
          {p.manifest.endpoint}
        </code>
      )}

      <div className="flex items-center gap-1 pt-1 border-t border-border/40 mt-auto">
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onTest}>
          <Play className="h-3 w-3" /> Test
        </Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={onEdit}>
          <Pencil className="h-3 w-3" /> Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3 w-3" /> Delete
        </Button>
      </div>
    </Card>
  )
}
