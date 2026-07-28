'use client'

import { Brain } from 'lucide-react'

export function ThinkingCard() {
  return (
    <div
      className="rounded-2xl border border-border bg-muted px-4 py-3"
      aria-label="AI is thinking"
    >
      <div className="flex items-center gap-2 text-xs text-foreground">
        <Brain className="h-4 w-4 text-primary" />
        <span>Thinking</span>
        <span className="inline-flex items-end gap-0.5">
          <span className="h-1 w-1 rounded-full bg-primary [animation:typing-dot_1.4s_ease-in-out_infinite] [animation-delay:-0.32s]" />
          <span className="h-1 w-1 rounded-full bg-primary [animation:typing-dot_1.4s_ease-in-out_infinite] [animation-delay:-0.16s]" />
          <span className="h-1 w-1 rounded-full bg-primary [animation:typing-dot_1.4s_ease-in-out_infinite]" />
        </span>
      </div>
    </div>
  )
}
