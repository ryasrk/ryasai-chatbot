'use client'

import { ChevronRight, MessageSquare, Bot } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

export function TogglePopup({
  isEnabled,
  chatEnabled,
  agenticEnabled,
  disabled,
  onToggle,
  onContextChange,
}: {
  isEnabled: boolean
  chatEnabled: boolean
  agenticEnabled: boolean
  disabled?: boolean
  onToggle: () => void
  onContextChange: (chat: boolean, agentic: boolean) => void
}) {
  // ponytail: no local state — props are the source of truth. Parent updates
  // via onContextChange and the new values flow back. Avoids setState-in-effect.
  return (
    <div className="flex items-center gap-1.5">
      <Switch checked={isEnabled} onCheckedChange={onToggle} disabled={disabled} />
      {isEnabled && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="rounded-md border border-border/60 p-1 text-muted-foreground hover:bg-muted transition-colors"
              title="Configure usage scope"
              disabled={disabled}
            >
              <ChevronRight className="h-3 w-3 rotate-90" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-3">
            <div className="space-y-2">
              <p className="text-xs font-medium">Use in</p>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={chatEnabled}
                  onCheckedChange={(v) => onContextChange(v === true, agenticEnabled)}
                />
                <span className="text-xs flex items-center gap-1.5">
                  <MessageSquare className="h-3 w-3" /> Chatbot
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={agenticEnabled}
                  onCheckedChange={(v) => onContextChange(chatEnabled, v === true)}
                />
                <span className="text-xs flex items-center gap-1.5">
                  <Bot className="h-3 w-3" /> Agentic
                </span>
              </label>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
