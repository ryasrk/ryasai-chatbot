'use client'

import { useState, useRef, useEffect, useCallback, type ComponentType } from 'react'
import {
  Bot, Send, Database, FileText, Plug, Activity, ShieldCheck, Brain,
  Wrench, Check, X, Loader2, ChevronDown, Sparkles, AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { chatSessionPanelWidthClass } from '@/lib/chat-layout'
import { SessionListPanel, type SessionListItem } from '@/components/ui/session-list-panel'
import { ChatMarkdown } from '@/components/ui/markdown'
import { MessageSquarePlus } from 'lucide-react'

interface ToolCard {
  stepId: string
  tool: string
  input: Record<string, string>
  output?: string
  status: 'running' | 'success' | 'failed'
  latencyMs?: number
  error?: string
}

interface ChatMessage {
  id: string
  role: 'user' | 'agent'
  content: string
  toolCards?: ToolCard[]
  thinkingSteps?: string[]
  createdAt?: string
}

const TOOL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  database: Database,
  knowledge: FileText,
  api: Plug,
  monitoring: Activity,
  security: ShieldCheck,
  provider: Brain,
}

const EXAMPLE_CHIPS = [
  'Connect PostgreSQL',
  'Create API Key',
  'Show today\'s API latency',
  'Reindex Knowledge',
]

const STATUS_CONFIG: Record<string, { label: string; className: string; borderClass: string; icon: ComponentType<{ className?: string }> }> = {
  running: { label: 'Running', className: 'bg-info/15 text-info', borderClass: 'border-info/40', icon: Loader2 },
  success: { label: 'Success', className: 'bg-success/15 text-success', borderClass: 'border-success/40', icon: Check },
  failed: { label: 'Failed', className: 'bg-destructive/15 text-destructive', borderClass: 'border-destructive/40', icon: X },
}

type AgentSession = SessionListItem

export function AgenticView() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [executing, setExecuting] = useState(false)
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [loadingSessions, setLoadingSessions] = useState(true)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const [sessionRailCollapsed, setSessionRailCollapsed] = useState(false)
  const [confirmationRequired, setConfirmationRequired] = useState(false)
  const [confirmationMessage, setConfirmationMessage] = useState('')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const idRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const sessionAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    abortControllerRef.current?.abort()
    sessionAbortRef.current?.abort()
  }, [])

  const loadSessions = useCallback(() => {
    setLoadingSessions(true)
    fetch('/api/agent/dashboard/sessions')
      .then((r) => r.json())
      .then((data) => {
        if (data?.sessions) setSessions(data.sessions)
      })
      .catch(() => {})
      .finally(() => setLoadingSessions(false))
  }, [])

  useEffect(() => { loadSessions() }, [loadSessions])

  const selectSession = useCallback(async (sessionId: string) => {
    sessionAbortRef.current?.abort()
    const ac = new AbortController()
    sessionAbortRef.current = ac
    setConversationId(sessionId)
    setMessages([])
    try {
      const res = await fetch(`/api/agent/dashboard/sessions?sessionId=${sessionId}`, { signal: ac.signal })
      const data = await res.json()
      if (ac.signal.aborted) return
      if (data?.messages) {
        const loaded: ChatMessage[] = data.messages.map((m: { id: string; sender: string; text: string; createdAt?: string }) => ({
          id: m.id,
          role: m.sender === 'user' ? 'user' : 'agent',
          content: m.text,
          createdAt: m.createdAt,
        }))
        setMessages(loaded)
      }
    } catch {
      // aborted or network error — ignore
    }
  }, [])

  const newSession = useCallback(() => {
    setConversationId(null)
    setMessages([])
  }, [])

  const deleteSession = useCallback(async (id: string) => {
    setDeletingSessionId(id)
    try {
      const res = await fetch(`/api/chat/sessions/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error('Failed to delete session')
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (conversationId === id) {
        setConversationId(null)
        setMessages([])
      }
      toast.success('Session deleted.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete session.')
    } finally {
      setDeletingSessionId(null)
    }
  }, [conversationId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking])

  const sendMessage = useCallback(async () => {
    const message = input.trim()
    if (!message || executing) return

    setConfirmationRequired(false)

    const userMsg: ChatMessage = { id: `m${++idRef.current}`, role: 'user', content: message, createdAt: new Date().toISOString() }
    const agentMsgId = `m${++idRef.current}`
    setMessages((prev) => [...prev, userMsg, { id: agentMsgId, role: 'agent', content: '', toolCards: [], createdAt: new Date().toISOString() }])
    setInput('')
    setExecuting(true)
    setThinking(true)

    try {
      const ac = new AbortController()
      abortControllerRef.current = ac
      const res = await fetch('/api/agent/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          sessionId: conversationId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        }),
        signal: ac.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }))
        toast.error(err.error ?? 'Request failed')
        setMessages((prev) => prev.map((m) => (m.id === agentMsgId ? { ...m, content: err.error ?? 'Request failed.' } : m)))
        return
      }

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
              handleEvent(currentEvent, data, agentMsgId)
            } catch {}
          }
        }
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        // user stopped — mark running tool cards as failed
        setMessages((prev) => prev.map((m) => (m.toolCards ? { ...m, toolCards: m.toolCards.map((tc) => (tc.status === 'running' ? { ...tc, status: 'failed' as const, error: 'Cancelled' } : tc)) } : m)))
      } else {
        toast.error('Connection lost')
      }
    } finally {
      setThinking(false)
      setExecuting(false)
    }
  }, [input, executing, conversationId])

  function handleEvent(event: string, data: Record<string, unknown>, agentMsgId: string) {
    switch (event) {
      case 'thinking':
        setThinking(true)
        setMessages((prev) => prev.map((m) => (m.id === agentMsgId ? { ...m, thinkingSteps: [...(m.thinkingSteps ?? []), 'Analyzing request...'] } : m)))
        break
      case 'plan': {
        const steps = Array.isArray(data.steps) ? data.steps : []
        const planLines = steps.map((s: { tool?: string }, i: number) => `Plan ${i + 1}: ${s.tool ?? 'unknown'}`)
        setMessages((prev) => prev.map((m) => (m.id === agentMsgId ? { ...m, thinkingSteps: [...(m.thinkingSteps ?? []), ...planLines] } : m)))
        break
      }
      case 'tool_start': {
        const stepId = data.stepId as string
        const tool = data.tool as string
        const input = (data.input as Record<string, string>) ?? {}
        setMessages((prev) => prev.map((m) => (m.id === agentMsgId ? { ...m, thinkingSteps: [...(m.thinkingSteps ?? []), `Running: ${tool}`] } : m)))
        setMessages((prev) => prev.map((m) => (m.id === agentMsgId && m.toolCards ? { ...m, toolCards: [...m.toolCards, { stepId, tool, status: 'running', input }] } : m)))
        break
      }
      case 'tool_end': {
        const status = (data.status as string) === 'success' ? 'success' : 'failed'
        setMessages((prev) => prev.map((m) => (m.id === agentMsgId ? { ...m, thinkingSteps: [...(m.thinkingSteps ?? []), `Done: ${data.tool} (${status})`] } : m)))
        setMessages((prev) =>
          prev.map((m) =>
            m.toolCards
              ? {
                  ...m,
                  toolCards: m.toolCards.map((tc) =>
                    tc.stepId === data.stepId
                      ? { ...tc, status, output: data.output as string, latencyMs: data.latencyMs as number, error: data.error as string | undefined }
                      : tc,
                  ),
                }
              : m,
          ),
        )
        break
      }
      case 'token': {
        const token = data.content as string
        setMessages((prev) => prev.map((m) => (m.id === agentMsgId ? { ...m, content: m.content + token } : m)))
        break
      }
      case 'answer':
        setThinking(false)
        setMessages((prev) => prev.map((m) => (m.id === agentMsgId ? { ...m, content: data.content as string } : m)))
        break
      case 'done':
        setMessages((prev) => prev.map((m) => (m.toolCards ? { ...m, toolCards: m.toolCards.map((tc) => (tc.status === 'running' ? { ...tc, status: 'failed' as const, error: 'Stream ended' } : tc)) } : m)))
        if (data.conversationId) setConversationId(data.conversationId as string)
        loadSessions()
        break
      case 'confirmation_required': {
        setThinking(false)
        const msg = (data.message as string) ?? 'Confirmation required.'
        setConfirmationRequired(true)
        setConfirmationMessage(msg)
        setMessages((prev) => prev.map((m) => (m.id === agentMsgId ? { ...m, content: msg } : m)))
        break
      }
      case 'error':
        setMessages((prev) => prev.map((m) => (m.toolCards ? { ...m, toolCards: m.toolCards.map((tc) => (tc.status === 'running' ? { ...tc, status: 'failed' as const, error: 'Stream ended' } : tc)) } : m)))
        toast.error((data.message as string) ?? 'An error occurred')
        setMessages((prev) => prev.map((m) => (m.id === agentMsgId ? { ...m, content: (data.message as string) ?? 'An error occurred.' } : m)))
        break
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="flex h-full gap-3">
      {/* Session rail — desktop only */}
      <aside
        className={cn(
          'hidden min-w-0 md:flex flex-col rounded-lg border bg-card overflow-hidden',
          'transition-[width,border-color,background-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width]',
          chatSessionPanelWidthClass(sessionRailCollapsed),
        )}
      >
        <SessionListPanel
          sessions={sessions}
          activeId={conversationId}
          loading={loadingSessions}
          deletingId={deletingSessionId}
          collapsed={sessionRailCollapsed}
          onCollapsedChange={setSessionRailCollapsed}
          onSelect={(id) => void selectSession(id)}
          onNew={newSession}
          onDelete={(id) => void deleteSession(id)}
          title="Agent Sessions"
          emptyHint="No agent sessions yet."
        />
      </aside>

      {/* Chat panel */}
      <div className="flex-1 flex flex-col min-w-0 rounded-lg border bg-card overflow-hidden relative">
        {/* mobile/portrait: floating session list button */}
        <Sheet
          open={mobileSidebarOpen}
          onOpenChange={setMobileSidebarOpen}
        >
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden absolute top-2 left-2 z-10 h-8 w-8"
              aria-label="Open agent sessions"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0">
            <SheetHeader className="px-4 pt-4">
              <SheetTitle>Agent Sessions</SheetTitle>
            </SheetHeader>
            <div className="flex-1 min-h-0 mt-2">
              <SessionListPanel
                sessions={sessions}
                activeId={conversationId}
                loading={loadingSessions}
                deletingId={deletingSessionId}
                collapsed={false}
                onSelect={(id) => {
                  void selectSession(id)
                  setMobileSidebarOpen(false)
                }}
                onNew={() => {
                  newSession()
                  setMobileSidebarOpen(false)
                }}
                onDelete={(id) => void deleteSession(id)}
                title="Agent Sessions"
                emptyHint="No agent sessions yet."
              />
            </div>
          </SheetContent>
        </Sheet>

        {/* Conversation area */}
        <div className={cn('flex-1 p-4 space-y-3', messages.length > 0 && 'overflow-y-auto')}>
          {messages.length === 0 ? (
            <EmptyState onChipClick={(text) => setInput(text)} />
          ) : (
            messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                thinking={thinking && msg.role === 'agent' && !msg.content}
              />
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Confirmation gate */}
        {confirmationRequired && (
          <div className="mx-4 mb-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-center gap-2 text-warning">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span className="text-xs font-semibold">Confirmation Required</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">{confirmationMessage}</p>
            <p className="text-xs text-warning mt-1.5 font-medium">
              Type &quot;confirm yes&quot; to continue.
            </p>
          </div>
        )}

        {/* Prompt input */}
        <div className="p-3 border-t">
          <div className="flex items-center gap-2 h-[84px] bg-input rounded-lg px-3">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Instruct the agent... (Enter to send)"
              className="flex-1 bg-transparent border-0 resize-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm min-h-[40px] max-h-[60px]"
              rows={1}
              disabled={executing}
            />
            {executing ? (
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
                onClick={sendMessage}
                disabled={!input.trim()}
                className="h-12 w-12 shrink-0 rounded-xl bg-primary hover:bg-primary/90 p-0"
                aria-label="Send"
              >
                <Send className="h-5 w-5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

function EmptyState({ onChipClick }: { onChipClick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center py-10">
      <div className="flex items-center justify-center h-14 w-14 rounded-xl bg-primary/10 text-primary mb-4">
        <Bot className="h-7 w-7" />
      </div>
      <div className="text-sm font-semibold text-foreground">Agentic Operations Console</div>
      <div className="text-xs text-muted-foreground mt-1 max-w-md">
        Instruct the agent to manage the dashboard, databases, APIs, and other operations.
      </div>
      <div className="flex flex-wrap gap-2 mt-5 justify-center max-w-md">
        {EXAMPLE_CHIPS.map((chip) => (
          <button
            key={chip}
            onClick={() => onChipClick(chip)}
            className="text-[11px] px-3 py-1.5 rounded-lg border border-border hover:bg-primary/10 hover:border-primary/30 transition-colors flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <Sparkles className="h-3 w-3 text-primary" />
            {chip}
          </button>
        ))}
      </div>
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

function MessageBubble({
  message,
  thinking,
}: {
  message: ChatMessage
  thinking: boolean
}) {
  const isUser = message.role === 'user'

  return (
    <div className={cn('group flex gap-2.5', isUser && 'flex-row-reverse')}>
      <div
        className={cn(
          'h-8 w-8 rounded-lg flex items-center justify-center shrink-0',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary',
        )}
      >
        {isUser ? <span className="text-[10px] font-semibold">You</span> : <Bot className="h-4 w-4" />}
      </div>
      <div className={cn('flex-1 min-w-0 space-y-2', isUser && 'flex flex-col items-end')}>
        {/* Thinking card */}
        {message.thinkingSteps && message.thinkingSteps.length > 0 && (
          <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 space-y-1.5 max-w-[90%]">
            <div className="text-[10px] font-semibold text-primary flex items-center gap-1.5">
              <Brain className="h-3 w-3" /> Thinking Process
            </div>
            {message.thinkingSteps.map((step, i) => (
              <div key={i} className="text-[11px] text-muted-foreground flex items-start gap-2">
                <Check className="h-3 w-3 text-primary shrink-0 mt-0.5" />
                <span>{step}</span>
              </div>
            ))}
          </div>
        )}

        {/* Thinking dots */}
        {thinking && (
          <div className="text-xs text-muted-foreground flex items-center gap-1.5">
            <span className="flex gap-0.5">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </span>
            Thinking...
          </div>
        )}

        {/* Content */}
        {message.content &&
          (isUser ? (
            <div className="bg-primary text-primary-foreground rounded-lg rounded-br-sm px-3.5 py-2 max-w-[80%] text-xs leading-relaxed whitespace-pre-wrap break-words">
              {message.content}
            </div>
          ) : (
            <div className="max-w-[90%]">
              <ChatMarkdown content={message.content} variant="agentic" />
            </div>
          ))}

        {/* Tool cards */}
        {message.toolCards?.map((tc) => (
          <ToolCardView key={tc.stepId} card={tc} />
        ))}

        {/* Hover time tooltip */}
        <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-[10px] text-muted-foreground">
          {formatTime(message.createdAt)}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tool execution card — colored outlines by status                    */
/* ------------------------------------------------------------------ */

function ToolCardView({ card }: { card: ToolCard }) {
  const [open, setOpen] = useState(false)
  const cfg = STATUS_CONFIG[card.status]
  const StatusIcon = cfg.icon
  const toolCategory = card.tool.split('.')[0] ?? card.tool
  const ToolIcon = TOOL_ICONS[toolCategory] ?? Wrench

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('rounded-lg border bg-muted/20', cfg.borderClass)}
    >
      <CollapsibleTrigger className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-muted/30 transition-colors">
        <ToolIcon className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-xs font-mono truncate flex-1">{card.tool}</span>
        <Badge variant="outline" className={cn('text-[10px] gap-0.5 px-1.5 py-0', cfg.className)}>
          <StatusIcon className={cn('h-2.5 w-2.5', card.status === 'running' && 'animate-spin')} />
          {cfg.label}
        </Badge>
        {card.latencyMs != null && (
          <span className="text-[10px] text-muted-foreground shrink-0">{card.latencyMs}ms</span>
        )}
        <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform shrink-0', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border px-2.5 py-2 space-y-1.5">
        {card.input && Object.keys(card.input).length > 0 && (
          <div>
            <div className="text-[10px] text-muted-foreground mb-0.5">Input</div>
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all">{JSON.stringify(card.input, null, 2)}</pre>
          </div>
        )}
        {card.output && (
          <div>
            <div className="text-[10px] text-muted-foreground mb-0.5">Output</div>
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto">{card.output}</pre>
          </div>
        )}
        {card.error && (
          <div>
            <div className="text-[10px] text-destructive mb-0.5">Error</div>
            <pre className="text-[10px] font-mono text-destructive whitespace-pre-wrap break-all">{card.error}</pre>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
