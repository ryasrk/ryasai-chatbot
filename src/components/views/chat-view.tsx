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
import { Fragment, useCallback, useEffect, useRef, useState, memo } from 'react'
import { toast } from 'sonner'
import { SessionListPanel } from '@/components/ui/session-list-panel'
import { ChatMarkdown } from '@/components/ui/markdown'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  Database,
  FileText,
  Globe,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Send,
  Server,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react'

import { useChatStore } from '@/store/useChatStore'
import { useActiveUser } from '@/hooks/use-active-user'
import type {
  ChartData,
  ChatMessageItem,
  ChatSessionItem,
  Citation,
} from '@/lib/types'
import {
  chatSessionPanelWidthClass,
  citationDetailLabel,
} from '@/lib/chat-layout'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SUGGESTED_PROMPTS = [
  'What is the total stock of product SKU-902 in the main warehouse?',
  'Show 5 customers with the highest total spending',
  'What are the payment terms for Enterprise customers?',
  'List invoices with overdue status',
] as const

const CHART_COLORS = ['#2563EB', '#7C3AED', '#16A34A', '#D97706', '#DC2626']

/* ------------------------------------------------------------------ */
/* Tool execution metadata                                            */
/* ------------------------------------------------------------------ */

type StepStatus = 'pending' | 'running' | 'done' | 'error'

interface PipelineState {
  thinking: StepStatus
  toolType: string
  tool: StepStatus
  answer: StepStatus
}

const INITIAL_PIPELINE: PipelineState = {
  thinking: 'pending',
  toolType: '',
  tool: 'pending',
  answer: 'pending',
}

// Status banner metadata per tool type (English labels, per spec).
const TOOL_META: Record<
  string,
  { label: string; icon: typeof Loader2; tone: string }
> = {
  SQL: {
    label: 'Running SQL query...',
    icon: Database,
    tone: 'text-info',
  },
  RAG: {
    label: 'Searching knowledge base documents...',
    icon: FileText,
    tone: 'text-primary',
  },
  REST_API: {
    label: 'Calling external API...',
    icon: Globe,
    tone: 'text-success',
  },
  CHAT: {
    label: 'Composing answer...',
    icon: MessageSquare,
    tone: 'text-muted-foreground',
  },
}

// Pipeline step icon + short label per tool type.
const TOOL_ICON: Record<string, typeof Loader2> = {
  SQL: Database,
  RAG: FileText,
  REST_API: Globe,
  CHAT: MessageSquare,
}

const TOOL_SHORT: Record<string, string> = {
  SQL: 'Query SQL',
  RAG: 'Knowledge Base',
  REST_API: 'REST API',
  CHAT: 'Chat',
}

// Data source badge shown above finalized AI messages.
const TOOL_BADGE: Record<
  string,
  { label: string; icon: typeof Loader2; className: string }
> = {
  SQL: {
    label: 'Database',
    icon: Database,
    className: 'border-info/30 bg-info/15 text-info',
  },
  RAG: {
    label: 'Knowledge Base',
    icon: FileText,
    className: 'border-primary/30 bg-primary/15 text-primary',
  },
  REST_API: {
    label: 'REST API',
    icon: Globe,
    className: 'border-success/30 bg-success/15 text-success',
  },
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export function ChatView() {
  const store = useChatStore()
  const { user } = useActiveUser()

  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [sessionRailCollapsed, setSessionRailCollapsed] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [loadingList, setLoadingList] = useState(true)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [pipeline, setPipeline] = useState<PipelineState>(INITIAL_PIPELINE)
  const [currentTool, setCurrentTool] = useState<string>('')
  const [pipelineVisible, setPipelineVisible] = useState(false)
  const [toolStartTime, setToolStartTime] = useState<number | null>(null)
  // Ref mirrors the active tool type so handleSseEvent (stable callback) can
  // stamp it onto the finalized AI message without a stale closure.
  const currentToolTypeRef = useRef<string>('')

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  /* ----- fetch sessions on mount ----- */
  const fetchSessions = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await fetch('/api/chat/sessions', { cache: 'no-store' })
      if (!res.ok) throw new Error('Failed to load session')
      const data = await res.json()
      const items: ChatSessionItem[] = data.items ?? []
      useChatStore.getState().setSessions(items)
      // auto-select the most recent session if any
      if (items.length > 0 && !useChatStore.getState().activeSessionId) {
        await selectSession(items[0].id)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load session list.')
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
  }, [])

  /* ----- auto-scroll on new messages / streaming ----- */
  // Streaming grows the last message's text without changing messages.length,
  // so track the last message length too (otherwise tokens render below the fold).
  const lastMsgLen = store.messages[store.messages.length - 1]?.text.length ?? 0
  useEffect(() => {
    const el = messagesEndRef.current
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [store.messages.length, lastMsgLen, store.currentStatus, store.isStreaming])

  /* ----- pipeline visibility: show while streaming, fade out 2s after ----- */
  useEffect(() => {
    if (store.isStreaming) {
      setPipelineVisible(true)
      return
    }
    if (!pipelineVisible) return
    const t = setTimeout(() => setPipelineVisible(false), 2000)
    return () => clearTimeout(t)
  }, [store.isStreaming, pipelineVisible])

  /* ----- session selection ----- */
  const selectSession = useCallback(
    async (id: string) => {
      setLoadingSession(true)
      useChatStore.getState().setActiveSession(id)
      try {
        const res = await fetch(`/api/chat/sessions/${id}`, {
          cache: 'no-store',
        })
        if (!res.ok) throw new Error('Failed to load session')
        const data = await res.json()
        const msgs: ChatMessageItem[] = data.messages ?? []
        useChatStore.getState().setMessages(msgs)
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : 'Failed to load session messages.',
        )
      } finally {
        setLoadingSession(false)
      }
    },
    [],
  )

  /* ----- new session ----- */
  const createSession = useCallback(async () => {
    try {
      const res = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) throw new Error('Failed to create session')
      const session: ChatSessionItem = await res.json()
      const chat = useChatStore.getState()
      chat.setSessions([session, ...chat.sessions])
      chat.setActiveSession(session.id)
      chat.setMessages([])
      setMobileSidebarOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create new session.')
    }
  }, [])

  /* ----- delete session ----- */
  const deleteSession = useCallback(
    async (id: string) => {
      setDeletingSessionId(id)
      try {
        const res = await fetch(`/api/chat/sessions/${id}`, {
          method: 'DELETE',
        })
        if (!res.ok && res.status !== 404) throw new Error('Failed to delete session')

        const listRes = await fetch('/api/chat/sessions', { cache: 'no-store' })
        if (!listRes.ok) throw new Error('Failed to reload session list')
        const data = await listRes.json()
        const remaining: ChatSessionItem[] = data.items ?? []
        const chat = useChatStore.getState()
        chat.setSessions(remaining)

        if (chat.activeSessionId === id) {
          chat.setActiveSession(null)
          chat.setMessages([])
          if (remaining.length > 0) {
            await selectSession(remaining[0].id)
          }
        }
        toast.success('Session deleted.')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to delete session.')
      } finally {
        setDeletingSessionId(null)
      }
    },
    [],
  )

  /* ----- SSE event handler ----- */
  const handleSseEvent = useCallback(
    (
      event: string,
      data: Record<string, unknown>,
      userPlaceholderId: string,
      aiPlaceholderId: string,
    ) => {
      const chat = useChatStore.getState()
      switch (event) {
        case 'user_message': {
          const current = chat.messages
          chat.setMessages(
            current.map((m) =>
              m.id === userPlaceholderId
                ? {
                    ...m,
                    id: data.id as string,
                    text: data.text as string,
                    createdAt: data.createdAt as string,
                  }
                : m,
            ),
          )
          break
        }
        case 'thinking':
          setPipeline((p) => ({ ...p, thinking: 'running' }))
          chat.setStatus('thinking', 'Analyzing question...')
          break
        case 'tool_start': {
          const tool = (data.tool as string) ?? ''
          const label =
            (data.label as string | undefined) ??
            TOOL_META[tool]?.label ??
            `Running ${tool}...`
          currentToolTypeRef.current = tool
          setCurrentTool(tool)
          setToolStartTime(Date.now())
          setPipeline((p) => ({
            ...p,
            thinking: 'done',
            toolType: tool,
            tool: 'running',
          }))
          chat.setStatus('tool', label)
          break
        }
        case 'tool_end': {
          const ok = (data.status as string) !== 'error'
          setPipeline((p) => ({ ...p, tool: ok ? 'done' : 'error' }))
          chat.setStatus(ok ? 'done' : 'error', ok ? 'Done' : 'Failed')
          break
        }
        case 'token': {
          const token = data.content as string
          chat.updateLastAiMessage(token)
          if (chat.currentStatus !== 'generating') {
            chat.setStatus('generating', 'Composing answer...')
          }
          setPipeline((p) =>
            p.answer === 'running'
              ? p
              : {
                  ...p,
                  answer: 'running',
                  thinking: 'done',
                  tool: p.tool === 'error' ? 'error' : 'done',
                },
          )
          break
        }
        case 'answer': {
          chat.finalizeLastAiMessage({
            text_final: data.content as string,
            citations: data.citations as Citation[] | undefined,
            chartData: (data.chartData as ChartData | null) ?? null,
          })
          setPipeline((p) => ({
            ...p,
            thinking: 'done',
            tool: p.tool === 'error' ? 'error' : 'done',
            answer: 'done',
          }))
          // Swap placeholder id with the real DB id, attach integration + tool type.
          const toolType = currentToolTypeRef.current || null
          if (data.messageId || data.integration || toolType) {
            const msgs = useChatStore.getState().messages
            useChatStore.getState().setMessages(
              msgs.map((m) =>
                m.id === aiPlaceholderId
                  ? {
                      ...m,
                      ...(data.messageId ? { id: data.messageId as string } : {}),
                      integration: (data.integration as {
                        id: string
                        name: string
                      } | null) ?? null,
                      toolType,
                    }
                  : m,
              ),
            )
          }
          break
        }
        case 'done': {
          // Reload session list (title may have changed for new sessions).
          fetch('/api/chat/sessions', { cache: 'no-store' })
            .then((r) => r.json())
            .then((d) =>
              useChatStore.getState().setSessions(
                (d.items as ChatSessionItem[]) ?? [],
              ),
            )
            .catch(() => {})
          break
        }
        case 'error': {
          const message = (data.message as string) ?? 'An error occurred.'
          const current = chat.messages
          chat.setMessages(
            current.map((item) =>
              item.id === aiPlaceholderId
                ? { ...item, text: message, status: 'error' }
                : item,
            ),
          )
          setPipeline((p) => ({
            ...p,
            thinking: p.thinking === 'running' ? 'error' : p.thinking,
            tool: p.tool === 'running' ? 'error' : p.tool,
            answer: 'error',
          }))
          chat.setError(message)
          toast.error(message)
          break
        }
      }
    },
    [setPipeline, setCurrentTool],
  )

  /* ----- send message ----- */
  const handleSend = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim()
      if (!text || sending || store.isStreaming) return
      if (!user) {
        toast.error('User not loaded yet. Try again.')
        return
      }
      // Ensure we have an active session — auto-create if none.
      let sessionId = store.activeSessionId
      if (!sessionId) {
        try {
          const res = await fetch('/api/chat/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: text.slice(0, 60) }),
          })
          if (!res.ok) throw new Error('Failed to create session')
          const session: ChatSessionItem = await res.json()
          const chat = useChatStore.getState()
          chat.setSessions([session, ...chat.sessions])
          chat.setActiveSession(session.id)
          sessionId = session.id
        } catch (e) {
          toast.error(
            e instanceof Error ? e.message : 'Failed to create new session.',
          )
          return
        }
      }

      setInput('')
      setSending(true)

      // 1) Persist the user message (the WS service handles the AI message).
      const userMessage: ChatMessageItem = {
        id: `user-${Date.now()}`,
        sender: 'user',
        text,
        createdAt: new Date().toISOString(),
      }
      const aiPlaceholder: ChatMessageItem = {
        id: `ai-${Date.now()}`,
        sender: 'ai',
        text: '',
        status: 'generating',
        createdAt: new Date().toISOString(),
      }
      store.addMessage(userMessage)
      store.addMessage(aiPlaceholder)
      store.setStreaming(true)
      currentToolTypeRef.current = ''
      setCurrentTool('')
      setPipeline({ thinking: 'running', toolType: '', tool: 'pending', answer: 'pending' })
      setPipelineVisible(true)
      setToolStartTime(null)
      store.setStatus('thinking', 'Processing question...')

      try {
        const ac = new AbortController()
        abortControllerRef.current = ac
        const res = await fetch(`/api/chat/sessions/${sessionId}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }),
          signal: ac.signal,
        })
        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ error: 'Failed to process chat.' }))
          throw new Error(
            typeof err?.error === 'string' ? err.error : 'Failed to process chat.',
          )
        }

        // SSE parsing — read event/data pairs from the stream.
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let currentEvent = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6))
                handleSseEvent(
                  currentEvent,
                  data,
                  userMessage.id,
                  aiPlaceholder.id,
                )
              } catch {}
            }
          }
        }
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          store.setStreaming(false)
          store.setStatus('', '')
          const current = useChatStore.getState().messages
          store.setMessages(
            current.map((item) =>
              item.id === aiPlaceholder.id
                ? { ...item, text: 'Cancelled.', status: 'error' }
                : item,
            ),
          )
        } else {
          const message =
            e instanceof Error ? e.message : 'Failed to process chat.'
          const current = useChatStore.getState().messages
          store.setMessages(
            current.map((item) =>
              item.id === aiPlaceholder.id
                ? {
                    ...item,
                    text: message,
                    status: 'error',
                  }
                : item,
            ),
          )
          store.setError(message)
          toast.error(message)
        }
      } finally {
        setSending(false)
      }
    },
    [
      input,
      sending,
      store.isStreaming,
      store.activeSessionId,
      store.sessions,
      user,
      handleSseEvent,
    ],
  )

  /* ----- retry last failed turn ----- */
  const handleRetry = useCallback(() => {
    const chat = useChatStore.getState()
    const msgs = chat.messages
    // Find the last user message; drop it + the trailing error AI bubble,
    // then re-send the same text (handleSend re-adds both fresh).
    let lastUserIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].sender === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx === -1) return
    const text = msgs[lastUserIdx].text
    chat.setMessages(msgs.slice(0, lastUserIdx))
    chat.setError(null)
    void handleSend(text)
  }, [handleSend])

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

  const hasMessages = store.messages.length > 0
  const isStreaming = store.isStreaming
  const canSend =
    input.trim().length > 0 && !isStreaming && !sending

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
            ref={scrollContainerRef}
            className={cn('flex-1 p-4 space-y-3', hasMessages && !loadingSession && 'overflow-y-auto')}
          >
            {loadingSession ? (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading conversation...
              </div>
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



/* ------------------------------------------------------------------ */
/* Connection badge                                                    */
/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

function EmptyState({ onPickPrompt }: { onPickPrompt: (p: string) => void }) {
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

/* ------------------------------------------------------------------ */
/* Tool execution pipeline                                             */
/* ------------------------------------------------------------------ */

const STEP_TONE: Record<StepStatus, string> = {
  pending: 'bg-muted/40 text-muted-foreground/50 border border-border/50',
  running: 'bg-primary/20 text-primary border border-primary/40 animate-pulse',
  done: 'bg-success/15 text-success border border-success/30',
  error: 'bg-destructive/15 text-destructive border border-destructive/30',
}

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

function ToolPipeline({ pipeline }: { pipeline: PipelineState }) {
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

/* ------------------------------------------------------------------ */
/* Data source badge                                                   */
/* ------------------------------------------------------------------ */

function DataSourceBadge({ toolType }: { toolType: string }) {
  const meta = TOOL_BADGE[toolType]
  if (!meta) return null
  const Icon = meta.icon
  return (
    <div className="mb-1.5">
      <Badge
        variant="outline"
        className={cn('text-[10px] gap-1 py-0.5', meta.className)}
      >
        <Icon className="h-3 w-3" />
        {meta.label}
      </Badge>
     </div>
   )
 }

/* ------------------------------------------------------------------ */
/* Message bubble                                                      */
/* ------------------------------------------------------------------ */

// ponytail: local-time HH:MM, no Intl dependency
function formatTime(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// Memoized so a streaming token (which only changes the last message's object
// reference) doesn't re-render / re-parse markdown for every other message.
const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessageItem }) {
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
          {!isStreaming && message.toolType && TOOL_BADGE[message.toolType] && (
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

          {/* Integration footer */}
          {message.integration && (
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

/* ------------------------------------------------------------------ */
/* Thinking card (streaming placeholder)                               */
/* ------------------------------------------------------------------ */

function ThinkingCard() {
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

/* ------------------------------------------------------------------ */
/* Tool execution card (inline while a tool runs)                      */
/* ------------------------------------------------------------------ */

function ToolExecutionCard({
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
        'rounded-sm border p-[18px] bg-muted flex items-start gap-3',
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

/* ------------------------------------------------------------------ */
/* Citation list                                                       */
/* ------------------------------------------------------------------ */

function CitationList({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(true)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-1 min-w-0 rounded-lg bg-secondary/50 p-3">
      <CollapsibleTrigger className="flex min-w-0 w-full items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
        <FileText className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">Sources ({citations.length})</span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 ml-auto transition-transform',
            open && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="min-w-0 space-y-2 mt-2">
          {citations.map((c, idx) => {
            const isDb = c.type === 'DATABASE'
            const score =
              typeof c.score === 'number' ? Math.round(c.score * 100) : null
            return (
              <div
                key={idx}
                className="min-w-0 overflow-hidden rounded-lg border bg-background/60 px-3 py-2"
              >
                <div className="grid min-w-0 gap-2 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
                  <Badge
                    variant="outline"
                    className={cn(
                      'w-fit text-[10px] gap-1',
                    isDb
                      ? 'border-info/30 bg-info/15 text-info'
                      : 'border-primary/30 bg-primary/15 text-primary',
                    )}
                  >
                    {isDb ? (
                      <Database className="h-3 w-3" />
                    ) : (
                      <FileText className="h-3 w-3" />
                    )}
                    {c.type}
                  </Badge>
                  <span className="min-w-0 break-words text-xs font-medium [overflow-wrap:anywhere]">
                    {c.source}
                  </span>
                  {score !== null && (
                    <Badge
                      variant="outline"
                      className="text-[10px] text-muted-foreground shrink-0"
                    >
                      relevance {score}%
                    </Badge>
                  )}
                </div>

                {c.snippet && (
                  <p className="mt-2 rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                    {c.snippet}
                  </p>
                )}

                {c.query_used && c.query_used.trim().length > 0 && (
                  <details className="mt-2 group">
                    <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground select-none flex items-center gap-1">
                      <span className="group-open:rotate-90 transition-transform">
                        ▸
                      </span>
                      {citationDetailLabel(c.type)}
                    </summary>
                    <pre className="mt-1.5 max-w-full rounded-md bg-muted/60 border p-2 overflow-x-auto text-[11px] font-mono leading-relaxed">
                      <code>{c.query_used}</code>
                    </pre>
                  </details>
                )}
              </div>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/* ------------------------------------------------------------------ */
/* Chart renderer                                                      */
/* ------------------------------------------------------------------ */

function ChartRenderer({ data }: { data: ChartData }) {
  if (!data || !Array.isArray(data.data) || data.data.length === 0) {
    return null
  }

  const rows = data.data
  const xKey = data.xKey
  const yKeys = data.yKeys ?? []

  if (yKeys.length === 0) {
    return null
  }

  return (
    <div className="mt-1 pt-3 border-t">
      <Card className="shadow-none">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Query Result Data Visualization
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              {data.type === 'bar' ? (
                <BarChart
                  data={rows}
                  margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    vertical={false}
                  />
                  <XAxis
                    dataKey={xKey}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <RTooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid hsl(var(--border))',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {yKeys.map((k, i) => (
                    <Bar
                      key={k}
                      dataKey={k}
                      fill={CHART_COLORS[i % CHART_COLORS.length]}
                      radius={[4, 4, 0, 0]}
                    />
                  ))}
                </BarChart>
              ) : data.type === 'line' ? (
                <LineChart
                  data={rows}
                  margin={{ top: 8, right: 8, bottom: 8, left: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="hsl(var(--border))"
                    vertical={false}
                  />
                  <XAxis
                    dataKey={xKey}
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <RTooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid hsl(var(--border))',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {yKeys.map((k, i) => (
                    <Line
                      key={k}
                      dataKey={k}
                      type="monotone"
                      stroke={CHART_COLORS[i % CHART_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                  ))}
                </LineChart>
              ) : (
                <PieChart>
                  <RTooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: '1px solid hsl(var(--border))',
                      fontSize: 12,
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Pie
                    data={rows}
                    dataKey={yKeys[0]}
                    nameKey={xKey}
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label={(entry: { name?: string }) => entry?.name ?? ''}
                    labelLine={false}
                  >
                    {rows.map((_, i) => (
                      <Cell
                        key={i}
                        fill={CHART_COLORS[i % CHART_COLORS.length]}
                      />
                    ))}
                  </Pie>
                </PieChart>
              )}
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
