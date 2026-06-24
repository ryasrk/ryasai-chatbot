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
      const updated = [...state.messages]
      const last = updated[updated.length - 1]
      if (last && last.sender === 'ai') {
        last.text += token
      }
      return { messages: updated }
    }),

  finalizeLastAiMessage: (payload) =>
    set((state) => {
      const updated = [...state.messages]
      const last = updated[updated.length - 1]
      if (last && last.sender === 'ai') {
        last.text = payload.text_final
        last.citations = payload.citations ?? null
        last.chartData = payload.chartData ?? null
        last.status = 'complete'
      }
      return { messages: updated, isStreaming: false, currentStatus: '', currentStatusMessage: '' }
    }),

  setStatus: (status, message) =>
    set({ currentStatus: status, currentStatusMessage: message ?? '' }),

  setError: (error) => set({ error, isStreaming: false, currentStatus: '', currentStatusMessage: '' }),
  setStreaming: (v) => set({ isStreaming: v }),
  clearChat: () => set({ messages: [], isStreaming: false, currentStatus: '', currentStatusMessage: '', error: null }),
}))
