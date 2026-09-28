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
import { useCallback, useEffect, useState } from 'react'
import {
  Database,
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

  /**
   * Data sources the user can pin a question to.
   *
   * Fetched lazily and kept small: the picker only needs id + name. Loading it here (rather than in
   * the composer) means one fetch for the whole view instead of one per keystroke.
   */
  /*
   * KNOWING LIMIT, recorded so it is not rediscovered: this picker offers only the connected DATABASES.
   *
   * MEASURED IN UAT: a knowledge officer who knew the answer was in a policy document could not pin the retriever to
   * documents — the one control that makes retrieval deterministic, missing for exactly the questions where a
   * semantic miss cannot be recovered by rewording.
   *
   * WHY IT IS STILL DATABASES ONLY: pinning a document set needs support this path does not have. `/send` resolves
   * `integrationId` against `Integration` (400 when it does not match) and has no `documentIds` concept; and
   * `integrationIds: []` is UNRESTRICTED by design (`intScope` resolves an empty list to `{}`), so an empty list does
   * NOT exclude the databases. A "Documents" option was written, checked against those facts, and removed — a control
   * that silently changes nothing is worse than an absent one, because the user believes they constrained the search.
   * Doing it properly means threading a scope through `/send` and the router's decision step.
   */
  const [chatSources, setChatSources] = useState<{ id: string; name: string }[]>([])
  const [pinnedSource, setPinnedSource] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/integrations', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        const list = (j?.integrations ?? j?.data ?? []) as Array<{ id: string; name: string; status?: string }>
        setChatSources(
          list.filter((i) => !i.status || i.status === 'active').map((i) => ({ id: i.id, name: i.name })),
        )
      })
      .catch(() => {
        // Non-fatal: without the list the picker is hidden and the router auto-selects, which is the
        // behaviour before this feature. Failing the composer over a convenience fetch would be worse.
      })
    return () => {
      cancelled = true
    }
  }, [])

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
            {/*
              Source pin, rendered ONLY when more than one source exists.

              With zero or one source there is nothing to choose between, and an always-visible
              dropdown that can never change the answer is noise that trains people to ignore the
              whole area.
            */}
            {chatSources.length > 1 && (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
                <Database className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">Answer from:</span>
                <select
                  value={pinnedSource}
                  onChange={(e) => setPinnedSource(e.target.value)}
                  disabled={isStreaming || sending}
                  className="rounded-sm border bg-background px-1.5 py-0.5 text-[11px] disabled:opacity-50"
                >
                  <option value="">Auto — let the router choose</option>
                  {chatSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {pinnedSource && (
                  // States plainly that this pins the SOURCE, not just the wording. Without it a user
                  // cannot tell why a question stopped reaching the document they expected.
                  <span className="text-muted-foreground">
                    — other sources are excluded for this turn
                  </span>
                )}
              </div>
            )}
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
                  onClick={() => void handleSend(undefined, undefined, pinnedSource || null)}
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
