'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useChatStore } from '@/store/useChatStore'
import type { ChatMessageItem, ChatSessionItem } from '@/lib/types'

export function useChatSessions(onSessionCreated: () => void) {
  const [loadingList, setLoadingList] = useState(true)
  const [loadingSession, setLoadingSession] = useState(false)
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null)
  const sessionAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    sessionAbortRef.current?.abort()
  }, [])

  /* ----- session selection ----- */
  // ponytail: defined before fetchSessions so the forward reference in
  // fetchSessions' useCallback deps resolves cleanly (react-hooks/exhaustive-deps).
  const selectSession = useCallback(
    async (id: string) => {
      sessionAbortRef.current?.abort()
      const ac = new AbortController()
      sessionAbortRef.current = ac
      setLoadingSession(true)
      useChatStore.getState().setActiveSession(id)
      try {
        const res = await fetch(`/api/chat/sessions/${id}`, {
          cache: 'no-store',
          signal: ac.signal,
        })
        if (!res.ok) throw new Error('Failed to load session')
        const data = await res.json()
        if (ac.signal.aborted) return
        const msgs: ChatMessageItem[] = data.messages ?? []

        // DO NOT DISCARD AN IN-FLIGHT TURN. The server returns PERSISTED messages only, so a
        // plain `setMessages(msgs)` wipes any local row that has not been saved yet — which is
        // exactly the streaming placeholder the answer is about to be finalized into.
        //
        // MEASURED (e2e/03-knowledge-chat with memory enabled): the SSE `answer` frame carried
        // 2 citations, the placeholder was confirmed present right after addMessage, and the
        // store then read `[user, ai(previous), user]` at assertion time. `finalizeLastAiMessage`
        // found its last row was not an AI row, took the early return, and dropped the answer
        // plus both citations — the warning it now logs fired once, reporting exactly that.
        //
        // Local rows are kept when they are still streaming or when the server has not caught
        // up with them yet; server rows win for everything already persisted, so an edit or
        // delete on another device is still reflected.
        const persistedIds = new Set(msgs.map((m) => m.id))
        const inFlight = useChatStore
          .getState()
          .messages.filter((m) => m.status === 'generating' || !persistedIds.has(m.id))
          .filter((m) => !msgs.some((server) => server.id === m.id))

        useChatStore.getState().setMessages(inFlight.length > 0 ? [...msgs, ...inFlight] : msgs)
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return
        toast.error(
          e instanceof Error ? e.message : 'Failed to load session messages.',
        )
      } finally {
        if (!ac.signal.aborted) setLoadingSession(false)
      }
    },
    [],
  )

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
  }, [selectSession])

  useEffect(() => {
    fetchSessions()
  }, [fetchSessions])

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
      onSessionCreated()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create new session.')
    }
  }, [onSessionCreated])

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
    [selectSession],
  )

  return {
    loadingList,
    loadingSession,
    deletingSessionId,
    selectSession,
    fetchSessions,
    createSession,
    deleteSession,
  }
}
