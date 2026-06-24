'use client'

/**
 * ChatView — the centerpiece of the Enterprise AI Internal Assistant.
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
 *   2. POST /api/chat/sessions/[id]/messages  { sender:'user', text }   (persist user msg)
 *   3. addMessage(userMsg) to the store
 *   4. sendMessage({ text, sessionId, user, integrationId }) — the hook emits
 *      `user_message` over WS, adds a placeholder AI message to the store,
 *      and the hook's internal listeners keep updating it (status_update /
 *      text_stream / message_complete).
 *   5. The WebSocket service (port 3003) persists the AI message — the
 *      frontend does NOT re-persist the AI message (would duplicate).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { id as idLocale } from 'date-fns/locale'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
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
  Brain,
  Database,
  FileText,
  Loader2,
  MessageSquarePlus,
  Plus,
  Search,
  Send,
  Server,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wand2,
  Wifi,
  WifiOff,
} from 'lucide-react'

import { useChatStore } from '@/store/useChatStore'
import { useChatSocket } from '@/hooks/use-chat-socket'
import { useActiveUser } from '@/hooks/use-active-user'
import type {
  ChartData,
  ChatMessageItem,
  ChatSessionItem,
  Citation,
  Integration,
} from '@/lib/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  'Berapa total stok produk SKU-902 di gudang utama?',
  'Tampilkan 5 pelanggan dengan total belanja tertinggi',
  'Apa kebijakan termin pembayaran untuk pelanggan Enterprise?',
  'Daftar invoice yang berstatus overdue',
] as const

const CHART_COLORS = [
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#f43f5e', // rose-500
  '#14b8a6', // teal-500
  '#8b5cf6', // violet-500
  '#d946ef', // fuchsia-500
  '#84cc16', // lime-500
  '#06b6d4', // cyan-500
]

const STATUS_META: Record<
  string,
  { label: string; icon: typeof Loader2; tone: string }
> = {
  routing: {
    label: 'AI sedang menganalisis pertanyaan Anda...',
    icon: Search,
    tone: 'text-emerald-600 dark:text-emerald-400',
  },
  executing_sql: {
    label: 'Menjalankan kueri pada database...',
    icon: Database,
    tone: 'text-amber-600 dark:text-amber-400',
  },
  rag_retrieving: {
    label: 'Mencari dokumen relevan...',
    icon: FileText,
    tone: 'text-violet-600 dark:text-violet-400',
  },
  generating: {
    label: 'Menyusun jawaban...',
    icon: Wand2,
    tone: 'text-teal-600 dark:text-teal-400',
  },
  error: {
    label: 'Terjadi kesalahan',
    icon: TriangleAlert,
    tone: 'text-rose-600 dark:text-rose-400',
  },
}

const AUTO_INTEGRATION_VALUE = '__auto__'

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export function ChatView() {
  const store = useChatStore()
  const { user } = useActiveUser()
  const { connected, sendMessage } = useChatSocket()

  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string>(
    AUTO_INTEGRATION_VALUE,
  )
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [loadingSession, setLoadingSession] = useState(false)
  const [loadingList, setLoadingList] = useState(true)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  /* ----- fetch sessions on mount ----- */
  const fetchSessions = useCallback(async () => {
    setLoadingList(true)
    try {
      const res = await fetch('/api/chat/sessions', { cache: 'no-store' })
      if (!res.ok) throw new Error('Gagal memuat sesi')
      const data = await res.json()
      const items: ChatSessionItem[] = data.items ?? []
      store.setSessions(items)
      // auto-select the most recent session if any
      if (items.length > 0 && !store.activeSessionId) {
        await selectSession(items[0].id)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal memuat daftar sesi.')
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    fetchSessions()
  }, [])

  /* ----- fetch integrations on mount ----- */
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/integrations', { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        const list: Integration[] = data?.data ?? []
        setIntegrations(list.filter((i) => i.status === 'active'))
      } catch {
        /* silent */
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  /* ----- auto-scroll on new messages / streaming ----- */
  useEffect(() => {
    const el = messagesEndRef.current
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [store.messages.length, store.currentStatus, store.isStreaming])

  /* ----- session selection ----- */
  const selectSession = useCallback(
    async (id: string) => {
      setLoadingSession(true)
      store.setActiveSession(id)
      try {
        const res = await fetch(`/api/chat/sessions/${id}`, {
          cache: 'no-store',
        })
        if (!res.ok) throw new Error('Gagal memuat sesi')
        const data = await res.json()
        const msgs: ChatMessageItem[] = data.messages ?? []
        store.setMessages(msgs)
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : 'Gagal memuat pesan sesi.',
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
        body: JSON.stringify({ title: 'Sesi Baru' }),
      })
      if (!res.ok) throw new Error('Gagal membuat sesi')
      const session: ChatSessionItem = await res.json()
      store.setSessions([session, ...store.sessions])
      store.setActiveSession(session.id)
      store.setMessages([])
      setMobileSidebarOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal membuat sesi baru.')
    }
  }, [])

  /* ----- delete session ----- */
  const deleteSession = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/chat/sessions/${id}`, {
          method: 'DELETE',
        })
        if (!res.ok) throw new Error('Gagal menghapus sesi')
        const remaining = store.sessions.filter((s) => s.id !== id)
        store.setSessions(remaining)
        if (store.activeSessionId === id) {
          store.setActiveSession(null)
          store.setMessages([])
          if (remaining.length > 0) await selectSession(remaining[0].id)
        }
        toast.success('Sesi dihapus.')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Gagal menghapus sesi.')
      }
    },
    [],
  )

  /* ----- send message ----- */
  const handleSend = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim()
      if (!text || sending || store.isStreaming) return
      if (!user) {
        toast.error('Pengguna belum dimuat. Coba lagi.')
        return
      }
      if (!connected) {
        toast.error('Koneksi WebSocket tidak aktif. Tunggu sebentar.')
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
          if (!res.ok) throw new Error('Gagal membuat sesi')
          const session: ChatSessionItem = await res.json()
          store.setSessions([session, ...store.sessions])
          store.setActiveSession(session.id)
          sessionId = session.id
        } catch (e) {
          toast.error(
            e instanceof Error ? e.message : 'Gagal membuat sesi baru.',
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
      store.addMessage(userMessage)

      try {
        await fetch(`/api/chat/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender: 'user', text }),
        })
      } catch (e) {
        console.warn('persist user msg failed', e)
        // non-fatal: the chat still streams; just log
      }

      // 2) Emit WS user_message — the hook adds the AI placeholder and
      //    updates it via status_update / text_stream / message_complete.
      const integrationId =
        selectedIntegrationId === AUTO_INTEGRATION_VALUE
          ? undefined
          : selectedIntegrationId

      sendMessage({ text, sessionId: sessionId, user, integrationId })
      setSending(false)
    },
    [
      input,
      sending,
      store.isStreaming,
      store.activeSessionId,
      store.sessions,
      user,
      connected,
      selectedIntegrationId,
    ],
  )

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
    input.trim().length > 0 && !isStreaming && !sending && connected

  /* ---------------------------------------------------------------- */
  /* Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="flex flex-col h-[calc(100vh-200px)] min-h-[480px] gap-3">
      <div className="flex flex-1 gap-3 min-h-0">
        {/* ---------- Sidebar (desktop) ---------- */}
        <aside className="hidden md:flex md:w-64 lg:w-72 shrink-0 flex-col rounded-xl border bg-card overflow-hidden">
          <SessionListPanel
            sessions={store.sessions}
            activeId={store.activeSessionId}
            loading={loadingList}
            onSelect={(id) => void selectSession(id)}
            onNew={createSession}
            onDelete={(id) => void deleteSession(id)}
          />
        </aside>

        {/* ---------- Center ---------- */}
        <div className="flex-1 flex flex-col min-w-0 rounded-xl border bg-card overflow-hidden">
          {/* chat topbar */}
          <header className="flex items-center justify-between gap-2 px-3 md:px-4 h-12 border-b bg-card/80 backdrop-blur">
            <div className="flex items-center gap-2 min-w-0">
              {/* mobile: open session sheet */}
              <Sheet
                open={mobileSidebarOpen}
                onOpenChange={setMobileSidebarOpen}
              >
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="md:hidden"
                    aria-label="Buka daftar sesi"
                  >
                    <MessageSquarePlus className="h-4 w-4" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-72 p-0">
                  <SheetHeader className="px-4 pt-4">
                    <SheetTitle>Sesi Chat</SheetTitle>
                  </SheetHeader>
                  <div className="flex-1 min-h-0 mt-2">
                    <SessionListPanel
                      sessions={store.sessions}
                      activeId={store.activeSessionId}
                      loading={loadingList}
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

              <Brain className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm font-medium truncate">
                AI Internal Assistant
              </span>
            </div>

            <ConnectionBadge connected={connected} />
          </header>

          {/* messages */}
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-y-auto px-3 md:px-4 py-4"
          >
            {loadingSession ? (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Memuat percakapan...
              </div>
            ) : !hasMessages ? (
              <EmptyState
                onPickPrompt={(p) => {
                  setInput(p)
                }}
              />
            ) : (
              <div className="space-y-4 max-w-3xl mx-auto">
                {store.messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>

          {/* status banner */}
          {isStreaming && (
            <StatusBanner
              status={store.currentStatus}
              message={store.currentStatusMessage}
            />
          )}

          {/* input area */}
          <div className="border-t bg-card/80 backdrop-blur px-3 md:px-4 py-3 space-y-2">
            {/* suggested prompt chips (only when no messages yet) */}
            {!hasMessages && (
              <div className="flex flex-wrap gap-1.5">
                {SUGGESTED_PROMPTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setInput(p)}
                    className="text-xs px-2.5 py-1 rounded-full border bg-background hover:bg-accent hover:text-accent-foreground transition-colors text-muted-foreground"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}

            {/* integration selector + warning row */}
            <div className="flex items-center gap-2 flex-wrap">
              <Select
                value={selectedIntegrationId}
                onValueChange={setSelectedIntegrationId}
              >
                <SelectTrigger className="h-8 w-auto gap-2 text-xs">
                  <Server className="h-3.5 w-3.5 text-muted-foreground" />
                  <SelectValue placeholder="Sumber Data" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_INTEGRATION_VALUE}>
                    Otomatis (RAG + DB)
                  </SelectItem>
                  {integrations.map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name} · {i.provider}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {!connected && (
                <Badge
                  variant="outline"
                  className="text-rose-600 border-rose-300 bg-rose-50 dark:bg-rose-950/30 dark:border-rose-800 dark:text-rose-300"
                >
                  <WifiOff className="h-3 w-3" />
                  Koneksi terputus
                </Badge>
              )}
            </div>

            {/* input row */}
            <div className="flex items-end gap-2">
              <Textarea
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder="Tulis pertanyaan Anda... (Enter untuk kirim, Shift+Enter untuk baris baru)"
                rows={1}
                className="min-h-[40px] max-h-40 resize-none"
                disabled={isStreaming || sending}
              />
              <Button
                onClick={() => void handleSend()}
                disabled={!canSend}
                size="icon"
                className="h-10 w-10 shrink-0"
                aria-label="Kirim pesan"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Session list panel                                                  */
/* ------------------------------------------------------------------ */

function SessionListPanel({
  sessions,
  activeId,
  loading,
  onSelect,
  onNew,
  onDelete,
}: {
  sessions: ChatSessionItem[]
  activeId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b">
        <Button
          onClick={onNew}
          size="sm"
          className="w-full"
          variant="default"
        >
          <Plus className="h-4 w-4" />
          Sesi Baru
        </Button>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Memuat...
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center py-8 text-xs text-muted-foreground">
              Belum ada sesi.
              <br />
              Klik “Sesi Baru” untuk memulai.
            </div>
          ) : (
            sessions.map((s) => {
              const active = s.id === activeId
              const count = s._count?.messages ?? 0
              return (
                <div
                  key={s.id}
                  className={cn(
                    'group relative rounded-lg px-3 py-2 cursor-pointer transition-colors',
                    active
                      ? 'bg-primary/10 ring-1 ring-primary/30'
                      : 'hover:bg-muted',
                  )}
                  onClick={() => onSelect(s.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          'text-sm font-medium truncate',
                          active ? 'text-primary' : 'text-foreground',
                        )}
                      >
                        {s.title || 'Tanpa Judul'}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        {formatDistanceToNow(new Date(s.createdAt), {
                          addSuffix: false,
                          locale: idLocale,
                        })}{' '}
                        lalu
                      </div>
                    </div>
                    {count > 0 && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] px-1.5 py-0 h-4"
                      >
                        {count}
                      </Badge>
                    )}
                  </div>

                  {/* delete button — visible on hover */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(s.id)
                    }}
                    className="absolute right-1 top-1 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-opacity"
                    aria-label="Hapus sesi"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )
            })
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Connection badge                                                    */
/* ------------------------------------------------------------------ */

function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'text-[11px] gap-1.5 py-0.5',
        connected
          ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-800 dark:text-emerald-300'
          : 'border-rose-300 bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:border-rose-800 dark:text-rose-300',
      )}
    >
      {connected ? (
        <Wifi className="h-3 w-3" />
      ) : (
        <WifiOff className="h-3 w-3" />
      )}
      {connected ? 'Terhubung' : 'Terputus'}
    </Badge>
  )
}

/* ------------------------------------------------------------------ */
/* Empty state                                                         */
/* ------------------------------------------------------------------ */

function EmptyState({ onPickPrompt }: { onPickPrompt: (p: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-4 py-8">
      <div className="flex items-center justify-center h-16 w-16 rounded-2xl bg-primary/10 text-primary mb-4">
        <Brain className="h-8 w-8" />
      </div>
      <h3 className="text-lg font-semibold">Mulai percakapan dengan AI Internal Assistant</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-md">
        Tanyakan apa saja seputar data perusahaan Anda — stok produk, pelanggan,
        invoice, kebijakan, atau dokumen lainnya. AI akan otomatis memilih sumber
        data yang tepat.
      </p>

      <div className="mt-6 w-full max-w-lg">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
          <Sparkles className="h-3.5 w-3.5" />
          Coba pertanyaan berikut
        </div>
        <div className="grid sm:grid-cols-2 gap-2">
          {SUGGESTED_PROMPTS.map((p) => (
            <button
              key={p}
              onClick={() => onPickPrompt(p)}
              className="text-left text-sm px-3 py-2 rounded-lg border bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              {p}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Status banner                                                       */
/* ------------------------------------------------------------------ */

function StatusBanner({
  status,
  message,
}: {
  status: string
  message?: string
}) {
  const meta = STATUS_META[status] ?? STATUS_META.routing
  const isError = status === 'error'
  const Icon = meta.icon
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 text-xs border-t',
        isError
          ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-300'
          : 'bg-muted/40 text-muted-foreground',
      )}
    >
      {!isError && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      <Icon className={cn('h-3.5 w-3.5', meta.tone)} />
      <span className="truncate">
        {message?.trim() ? message : meta.label}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Message bubble                                                      */
/* ------------------------------------------------------------------ */

function MessageBubble({ message }: { message: ChatMessageItem }) {
  if (message.sender === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] sm:max-w-[75%] rounded-2xl rounded-br-md bg-primary text-primary-foreground px-4 py-2.5 text-sm shadow-sm whitespace-pre-wrap break-words">
          {message.text}
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
    <div className="flex justify-start gap-3">
      <div className="flex-shrink-0 mt-0.5">
        <div className="flex items-center justify-center h-8 w-8 rounded-full bg-primary/10 text-primary">
          <Brain className="h-4 w-4" />
        </div>
      </div>
      <div className="max-w-[85%] sm:max-w-[80%] min-w-0">
        <Card className="py-3 gap-3 shadow-none bg-background">
          <CardContent className="px-4 pt-0 pb-0">
            {isStreaming ? (
              <TypingDots />
            ) : (
              <div className="prose-chat text-sm leading-relaxed">
                <ReactMarkdown
                  components={{
                    h1: ({ children }) => (
                      <h3 className="text-base font-semibold mt-3 mb-1.5">
                        {children}
                      </h3>
                    ),
                    h2: ({ children }) => (
                      <h4 className="text-sm font-semibold mt-3 mb-1.5">
                        {children}
                      </h4>
                    ),
                    h3: ({ children }) => (
                      <h5 className="text-sm font-semibold mt-2 mb-1">
                        {children}
                      </h5>
                    ),
                    p: ({ children }) => (
                      <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>
                    ),
                    ul: ({ children }) => (
                      <ul className="list-disc pl-5 my-1.5 space-y-0.5">
                        {children}
                      </ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="list-decimal pl-5 my-1.5 space-y-0.5">
                        {children}
                      </ol>
                    ),
                    li: ({ children }) => <li>{children}</li>,
                    code: ({ children, className }) => {
                      const isBlock = (className ?? '').includes('language-')
                      if (isBlock) {
                        return (
                          <pre className="bg-muted/60 border rounded-md p-2 my-2 overflow-x-auto text-xs">
                            <code>{children}</code>
                          </pre>
                        )
                      }
                      return (
                        <code className="bg-muted/60 px-1 py-0.5 rounded text-xs font-mono">
                          {children}
                        </code>
                      )
                    },
                    pre: ({ children }) => <>{children}</>,
                    a: ({ children, href }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary underline underline-offset-2"
                      >
                        {children}
                      </a>
                    ),
                    table: ({ children }) => (
                      <div className="overflow-x-auto my-2">
                        <table className="w-full text-xs border-collapse">
                          {children}
                        </table>
                      </div>
                    ),
                    th: ({ children }) => (
                      <th className="border px-2 py-1 bg-muted/50 text-left font-semibold">
                        {children}
                      </th>
                    ),
                    td: ({ children }) => (
                      <td className="border px-2 py-1">{children}</td>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-2 border-primary/40 pl-3 italic text-muted-foreground my-2">
                        {children}
                      </blockquote>
                    ),
                  }}
                >
                  {message.text}
                </ReactMarkdown>
              </div>
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
                Sumber: {message.integration.name}
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  )
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

/* ------------------------------------------------------------------ */
/* Typing dots                                                         */
/* ------------------------------------------------------------------ */

function TypingDots() {
  return (
    <div className="flex items-center gap-1 py-1.5" aria-label="AI sedang mengetik">
      <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.3s]" />
      <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.15s]" />
      <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce" />
      <span className="ml-2 text-xs text-muted-foreground">Menyusun jawaban...</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Citation list                                                       */
/* ------------------------------------------------------------------ */

function CitationList({ citations }: { citations: Citation[] }) {
  return (
    <div className="mt-1 pt-3 border-t">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2">
        <FileText className="h-3.5 w-3.5" />
        Sumber Data
      </div>
      <div className="space-y-2">
        {citations.map((c, idx) => {
          const isDb = c.type === 'DATABASE'
          return (
            <div
              key={idx}
              className="rounded-lg border bg-background/60 px-3 py-2"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px] gap-1',
                    isDb
                      ? 'border-teal-300 bg-teal-50 text-teal-700 dark:bg-teal-950/30 dark:border-teal-800 dark:text-teal-300'
                      : 'border-violet-300 bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:border-violet-800 dark:text-violet-300',
                  )}
                >
                  {isDb ? (
                    <Database className="h-3 w-3" />
                  ) : (
                    <FileText className="h-3 w-3" />
                  )}
                  {c.type}
                </Badge>
                <span className="text-xs font-medium truncate">
                  {c.source}
                </span>
              </div>

              {c.query_used && c.query_used.trim().length > 0 && (
                <details className="mt-2 group">
                  <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground select-none flex items-center gap-1">
                    <span className="group-open:rotate-90 transition-transform">
                      ▸
                    </span>
                    Lihat kueri SQL
                  </summary>
                  <pre className="mt-1.5 rounded-md bg-muted/60 border p-2 overflow-x-auto text-[11px] font-mono leading-relaxed">
                    <code>{c.query_used}</code>
                  </pre>
                </details>
              )}
            </div>
          )
        })}
      </div>
    </div>
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
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary" />
            Visualisasi Data Hasil Kueri
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
