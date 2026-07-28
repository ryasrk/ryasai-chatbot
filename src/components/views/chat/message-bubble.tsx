'use client'

import { memo } from 'react'
import { Bot, Database } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { ChatMarkdown } from '@/components/ui/markdown'
import type { ChatMessageItem } from '@/lib/types'
import { ChartRenderer } from './chart-renderer'
import { CitationList } from './citation-list'
import { DataSourceBadge } from './data-source-badge'
import { ThinkingCard } from './thinking-card'
import { TOOL_BADGE } from './types'

// ponytail: local-time HH:MM, no Intl dependency
function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// helper: a message is "streaming" if it has no final text AND the store
// currently marks streaming active. We detect via the message status flag
// (set by the hook: 'routing' while pending, 'complete' once finalized).
function isAiMessageStreaming(message: ChatMessageItem): boolean {
  return (
    message.sender === 'ai' &&
    message.status !== 'complete' &&
    message.status !== 'error' &&
    !!message.status
  )
}

// Memoized so a streaming token (which only changes the last message's object
// reference) doesn't re-render / re-parse markdown for every other message.
export const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessageItem }) {
  if (message.sender === 'user') {
    return (
      <div className="group flex min-w-0 justify-end">
        <div className="max-w-[70%]">
          <div className="overflow-hidden rounded-2xl bg-primary/20 text-foreground px-4 py-2.5 text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {message.text}
          </div>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-[10px] text-muted-foreground mt-1 text-right">
            {formatTime(message.createdAt)}
          </div>
        </div>
      </div>
    )
  }

  if (message.sender === 'system') {
    return (
      <div className="flex justify-center">
        <div className="text-xs text-muted-foreground italic px-3 py-1 rounded-md bg-muted/40">
          {message.text}
        </div>
      </div>
    )
  }

  // AI message
  const isStreaming =
    isAiMessageStreaming(message) && (!message.text || message.text.length === 0)

  return (
    <div className="group flex justify-start gap-3">
      <div className="flex-shrink-0 mt-0.5">
        <div className="flex items-center justify-center h-8 w-8 rounded-full bg-primary/20 text-primary">
          <Bot className="h-4 w-4" />
        </div>
      </div>
      <div className="min-w-0 flex-1 max-w-[min(100%,52rem)]">
          {!isStreaming && message.toolType && message.toolHasResults && TOOL_BADGE[message.toolType] && (
            <DataSourceBadge toolType={message.toolType} />
          )}
          <Card className="overflow-hidden py-3 gap-3 shadow-none bg-transparent border-0">
          <CardContent className="min-w-0 px-4 pt-0 pb-0">
            {isStreaming ? (
              <ThinkingCard />
            ) : (
              <ChatMarkdown content={message.text} variant="agentic" />
            )}
          </CardContent>

          {/* Citations */}
          {message.citations && message.citations.length > 0 && (
            <CardContent className="px-4 pt-0">
              <CitationList citations={message.citations} />
            </CardContent>
          )}

          {/* Chart */}
          {message.chartData && (
            <CardContent className="px-4 pt-0">
              <ChartRenderer data={message.chartData} />
            </CardContent>
          )}

          {/* Integration footer — only when tool returned results */}
          {message.integration && message.toolHasResults && (
            <CardContent className="px-4 pt-0">
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Database className="h-3 w-3" />
                Source: {message.integration.name}
              </div>
            </CardContent>
          )}
        </Card>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-[10px] text-muted-foreground mt-1">
          {formatTime(message.createdAt)}
        </div>
      </div>
    </div>
  )
})
