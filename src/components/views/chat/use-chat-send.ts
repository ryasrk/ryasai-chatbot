'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useChatStore } from '@/store/useChatStore'
import { useActiveUser } from '@/hooks/use-active-user'
import type {
  ChartData,
  ChatMessageItem,
  ChatSessionItem,
  Citation,
} from '@/lib/types'
import { INITIAL_PIPELINE, TOOL_META } from './types'
import type { PipelineState } from './types'

export function useChatSend() {
  const store = useChatStore()
  const { user } = useActiveUser()

  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [pipeline, setPipeline] = useState<PipelineState>(INITIAL_PIPELINE)
  const [currentTool, setCurrentTool] = useState<string>('')
  const [pipelineVisible, setPipelineVisible] = useState(false)
  const [toolStartTime, setToolStartTime] = useState<number | null>(null)
  // Ref mirrors the active tool type so handleSseEvent (stable callback) can
  // stamp it onto the finalized AI message without a stale closure.
  const currentToolTypeRef = useRef<string>('')
  const toolHasResultsRef = useRef<boolean>(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortControllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    abortControllerRef.current?.abort()
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
          const ok = data.status === 'success'
          const hasResults = data.hasResults === true
          toolHasResultsRef.current = hasResults
          setPipeline((p) => ({ ...p, tool: ok ? 'done' : 'error' }))
          chat.setStatus(ok ? 'done' : 'error', ok ? (hasResults ? 'Done' : 'No data found') : 'Failed')
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
          const toolHasResults = data.toolHasResults === true || toolHasResultsRef.current
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
                      toolHasResults,
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
      toolHasResultsRef.current = false
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
      store,
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

  return {
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
  }
}
