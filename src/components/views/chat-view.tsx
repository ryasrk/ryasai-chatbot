'use client'

/**
 * ChatView — the centerpiece of ryasai.
 *
 * Implements spec §5.2 (streaming chat protocol), §6.2 (Zustand store
 * consumption), §6 (Recharts visualization).
 *
 * Three areas (responsive):
 *   • Left  : session list (desktop sidebar / mobile Sheet)
 *   • Center: message thread + status banner + input box
 *   • Inline below AI message: citations + chart (per spec: inline is allowed
 *     as long as citations are visible)
 *
 * Message flow:
 *   1. user types → Enter / Send
 *   2. POST /api/chat/sessions/[id]/send { text, integrationId? }
 *   3. API persists the user + AI messages and runs the shared production router.
 *   4. UI replaces optimistic placeholders with persisted messages.
 */
import { useCallback, useState } from 'react'
import {
  Loader2,
  MessageSquarePlus,
  Send,
  TriangleAlert,
} from 'lucide-react'

import { useChatStore } from '@/store/useChatStore'
import { chatSessionPanelWidthClass } from '@/lib/chat-layout'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { SessionListPanel } from '@/components/ui/session-list-panel'
import { ChatMessageSkeleton, Delayed } from '@/components/ui/view-states'

import { EmptyState } from './chat/empty-state'
import { MessageBubble } from './chat/message-bubble'
import { ToolExecutionCard } from './chat/tool-execution-card'
import { ToolPipeline } from './chat/tool-pipeline'
import { useChatSend } from './chat/use-chat-send'
import { useChatSessions } from './chat/use-chat-sessions'

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export function ChatView() {
  const store = useChatStore()

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [sessionRailCollapsed, setSessionRailCollapsed] = useState(false)

  const handleSessionCreated = useCallback(() => setMobileSidebarOpen(false), [])
  const {
    loadingList,
    loadingSession,
    deletingSessionId,
    selectSession,
    createSession,
    deleteSession,
  } = useChatSessions(handleSessionCreated)
  const {
    input,
    setInput,
    sending,
    pipeline,
    pipelineVisible,
    currentTool,
    toolStartTime,
    handleSend,
    handleRetry,
    messagesEndRef,
    abortControllerRef,
  } = useChatSend()

  const hasMessages = store.messages.length > 0
  const isStreaming = store.isStreaming
  const canSend =
    input.trim().length > 0 && !isStreaming && !sending

  /* ----- textarea enter-to-send ----- */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  /* ----- textarea auto-grow ----- */
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px' // ~5 rows
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="flex h-full gap-3">
        {/* ---------- Sidebar (desktop) ---------- */}
        <aside
          className={cn(
            'hidden min-w-0 md:flex flex-col rounded-lg border bg-card overflow-hidden',
            'transition-[width,border-color,background-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width]',
            chatSessionPanelWidthClass(sessionRailCollapsed),
          )}
        >
            <SessionListPanel
            sessions={store.sessions}
            activeId={store.activeSessionId}
            loading={loadingList}
            deletingId={deletingSessionId}
            collapsed={sessionRailCollapsed}
            onCollapsedChange={setSessionRailCollapsed}
            onSelect={(id) => void selectSession(id)}
            onNew={createSession}
            onDelete={(id) => void deleteSession(id)}
          />
        </aside>

        {/* ---------- Center ---------- */}
        <div className="flex-1 flex min-w-0 flex-col rounded-lg border bg-card overflow-hidden relative">
          {/* mobile: floating session list button */}
          <Sheet
            open={mobileSidebarOpen}
            onOpenChange={setMobileSidebarOpen}
          >
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden absolute top-2 left-2 z-10 h-8 w-8"
                aria-label="Open session list"
              >
                <MessageSquarePlus className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetHeader className="px-4 pt-4">
                <SheetTitle>Chat Sessions</SheetTitle>
              </SheetHeader>
              <div className="flex-1 min-h-0 mt-2">
                <SessionListPanel
                  sessions={store.sessions}
                  activeId={store.activeSessionId}
                  loading={loadingList}
                  deletingId={deletingSessionId}
                  collapsed={false}
                  onSelect={async (id) => {
                    await selectSession(id)
                    setMobileSidebarOpen(false)
                  }}
                  onNew={createSession}
                  onDelete={(id) => void deleteSession(id)}
                />
              </div>
            </SheetContent>
          </Sheet>

          {/* messages */}
          <div
            className={cn('flex-1 p-4 space-y-3', hasMessages && !loadingSession && 'overflow-y-auto')}
          >
            {loadingSession ? (
              <Delayed><ChatMessageSkeleton count={3} /></Delayed>
            ) : !hasMessages ? (
              <EmptyState
                onPickPrompt={(p) => {
                  setInput(p)
                }}
              />
            ) : (
              <>
                {store.error && (
                  <Alert variant="destructive" className="py-2">
                    <TriangleAlert />
                    <AlertTitle>Failed to process</AlertTitle>
                    <AlertDescription className="flex items-center justify-between gap-3">
                      <span className="text-xs">{store.error}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-xs"
                        onClick={handleRetry}
                      >
                        Try Again
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
                {store.messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
                {pipelineVisible &&
                  pipeline.tool !== 'pending' &&
                  currentTool && (
                    <ToolExecutionCard
                      toolType={currentTool}
                      status={pipeline.tool}
                      startedAt={toolStartTime}
                    />
                  )}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* tool execution pipeline (fades out 2s after streaming ends) */}
          <div
            className={cn(
              'grid transition-all duration-300 ease-out',
              pipelineVisible
                ? 'grid-rows-[1fr] opacity-100'
                : 'grid-rows-[0fr] opacity-0',
            )}
          >
            <div className="overflow-hidden">
              <ToolPipeline pipeline={pipeline} />
            </div>
          </div>

          {/* input area */}
          <div className="p-3 border-t">
            <div className="flex items-center gap-2 h-[84px] bg-input rounded-lg px-3">
              <Textarea
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Type a question..."
                rows={1}
                className="flex-1 bg-transparent border-0 resize-none focus-visible:ring-0 focus-visible:ring-offset-0 text-xs min-h-[40px] max-h-[60px]"
                disabled={isStreaming || sending}
              />
              {isStreaming ? (
                <Button
                  onClick={() => abortControllerRef.current?.abort()}
                  className="h-12 w-12 shrink-0 rounded-xl p-0"
                  variant="destructive"
                  aria-label="Stop"
                >
                  <Loader2 className="h-5 w-5 animate-spin" />
                </Button>
              ) : (
                <Button
                  onClick={() => void handleSend()}
                  disabled={!canSend}
                  className="h-12 w-12 shrink-0 rounded-xl bg-primary hover:bg-primary/90 p-0"
                  aria-label="Send message"
                >
                  {sending ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <Send className="h-5 w-5" />
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>
    </div>
  )
}
