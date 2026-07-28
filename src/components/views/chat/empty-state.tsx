'use client'

import { Bot, Sparkles } from 'lucide-react'
import { SUGGESTED_PROMPTS } from './types'

export function EmptyState({ onPickPrompt }: { onPickPrompt: (p: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-4 py-8">
      <div className="flex items-center justify-center h-14 w-14 rounded-xl bg-primary/10 text-primary mb-4">
        <Bot className="h-7 w-7" />
      </div>
      <div className="text-sm font-semibold text-foreground">Start a conversation with ryasai</div>
      <div className="text-xs text-muted-foreground mt-1 max-w-md">
        Ask about company data, documents, policies, or operational status.
        The router will choose RAG, SQL, REST API, or general chat.
      </div>
      <div className="flex flex-wrap gap-2 mt-5 justify-center max-w-md">
        {SUGGESTED_PROMPTS.map((p) => (
          <button
            key={p}
            onClick={() => onPickPrompt(p)}
            className="text-[11px] px-3 py-1.5 rounded-lg border border-border hover:bg-primary/10 hover:border-primary/30 transition-colors flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <Sparkles className="h-3 w-3 text-primary" />
            {p}
          </button>
        ))}
      </div>
    </div>
  )
}
