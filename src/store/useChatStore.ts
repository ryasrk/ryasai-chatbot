/**
 * 6.2 — Zustand Chat Store
 * ----------------------------------------------------------------------------
 * Mirrors the spec's `frontend/store/useChatStore.ts` interface, extended with
 * session management + streaming state for the WebSocket protocol (spec §5.2).
 */
import { create } from 'zustand'
import type { ChatMessageItem, ChatSessionItem, Citation, ChartData } from '@/lib/types'

interface ChatState {
  sessions: ChatSessionItem[]
  activeSessionId: string | null
  messages: ChatMessageItem[]
  isStreaming: boolean
  currentStatus: string
  currentStatusMessage: string
  error: string | null

  // session actions
  setSessions: (s: ChatSessionItem[]) => void
  setActiveSession: (id: string | null) => void
  setMessages: (m: ChatMessageItem[]) => void

  // message actions
  addMessage: (message: ChatMessageItem) => void
  updateLastAiMessage: (token: string) => void
  finalizeLastAiMessage: (payload: { text_final: string; citations?: Citation[]; chartData?: ChartData | null }) => void
  setStatus: (status: string, message?: string) => void
  setError: (error: string | null) => void
  setStreaming: (v: boolean) => void
  clearChat: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  isStreaming: false,
  currentStatus: '',
  currentStatusMessage: '',
  error: null,

  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (id) => set({ activeSessionId: id, messages: [], currentStatus: '', currentStatusMessage: '', error: null }),
  setMessages: (messages) => set({ messages }),

  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),

  updateLastAiMessage: (token) =>
    set((state) => {
      const last = state.messages[state.messages.length - 1]
      if (!last || last.sender !== 'ai') return {}
      // Immutable update: replace the last item with a new object so React 19
      // concurrent rendering (and React.memo) sees a real reference change.
      return { messages: [...state.messages.slice(0, -1), { ...last, text: last.text + token }] }
    }),

  finalizeLastAiMessage: (payload) =>
    set((state) => {
      const last = state.messages[state.messages.length - 1]
      if (!last || last.sender !== 'ai') {
        // THE ANSWER IS DROPPED HERE, SILENTLY — and this branch is reachable.
        //
        // MEASURED (e2e/03-knowledge-chat, memory enabled): the SSE `answer` frame carried
        // citations=2, the placeholder was confirmed present in the store right after
        // addMessage ("user,ai"), and yet this branch ran — leaving the store as
        // [user, ai(previous), user] with the new answer nowhere. The cause is that the
        // placeholder can be displaced before the answer arrives: `selectSession`
        // (use-chat-sessions.ts) does `setMessages(msgs)` from the server, and the server
        // only holds PERSISTED messages, so an in-flight placeholder is wiped.
        //
        // Returning early is still right — there is no AI row to finalize — but it must not
        // be SILENT, and the citations must not vanish without a trace. Logging turns a
        // mystery ("Sources never renders with memory on") into a direct diagnosis.
        console.warn(
          '[chat] answer arrived with no AI message to finalize — the placeholder was ' +
            'displaced (a session reload replaces messages with persisted rows only). ' +
            `Dropping ${payload.citations?.length ?? 0} citation(s) and the answer text.`,
        )
        return { isStreaming: false, currentStatus: '', currentStatusMessage: '' }
      }
      const finalized = {
        ...last,
        text: payload.text_final,
        citations: payload.citations ?? null,
        chartData: payload.chartData ?? null,
        status: 'complete',
      }
      return {
        messages: [...state.messages.slice(0, -1), finalized],
        isStreaming: false,
        currentStatus: '',
        currentStatusMessage: '',
      }
    }),

  setStatus: (status, message) =>
    set({ currentStatus: status, currentStatusMessage: message ?? '' }),

  setError: (error) => set({ error, isStreaming: false, currentStatus: '', currentStatusMessage: '' }),
  setStreaming: (v) => set({ isStreaming: v }),
  clearChat: () => set({ messages: [], isStreaming: false, currentStatus: '', currentStatusMessage: '', error: null }),
}))
