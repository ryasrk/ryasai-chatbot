/**
 * useChatSocket — socket.io client hook for the streaming chat protocol (spec §5.2).
 * Connects to the mini-service via the Caddy gateway
 * (`/?XTransformPort=<WS_PORT>`, path `/`).
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useChatStore } from '@/store/useChatStore'
import { publicConfig } from '@/lib/public-config'
import type { ActiveUser } from '@/lib/types'

export interface SendMessageArgs {
  text: string
  sessionId: string
  user: ActiveUser
  integrationId?: string
}

export function useChatSocket() {
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const store = useChatStore()

  // Always-current ref so the once-bound socket listeners (setup runs a single
  // time) never close over a stale store snapshot. Updated in effect to avoid render.
  const storeRef = useRef(store)

  useEffect(() => {
    storeRef.current = store
  }, [store])

  useEffect(() => {
    const socket = io(`/?XTransformPort=${publicConfig.wsPort}`, {
      path: '/',
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    })
    socketRef.current = socket

    const s = () => storeRef.current

    // Reset streaming state on disconnect so the UI can't get stuck on
    // "Menyusun jawaban…" if the socket drops (or the view unmounts mid-stream).
    const resetStream = () => {
      s().setStreaming(false)
      s().setStatus('', '')
    }

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => {
      setConnected(false)
      resetStream()
    })
    socket.on('connect_error', () => {
      setConnected(false)
      resetStream()
    })

    socket.on('status_update', (payload: { status: string; message?: string }) => {
      s().setStatus(payload.status, payload.message)
    })

    socket.on('text_stream', (payload: { token: string }) => {
      s().updateLastAiMessage(payload.token)
    })

    socket.on('message_complete', (payload: { text_final: string; citations?: any[]; chartData?: any }) => {
      s().finalizeLastAiMessage(payload)
    })

    return () => {
      // Cleanup runs before disconnect(), so reset here too — otherwise an
      // unmount mid-stream would leave isStreaming=true forever (all listeners
      // get removed before the disconnect event could fire).
      resetStream()
      socket.removeAllListeners()
      socket.disconnect()
    }
  }, [])

  async function sendMessage(args: SendMessageArgs) {
    const socket = socketRef.current
    const s = storeRef.current
    if (!socket || !connected) {
      s.setError('Koneksi WebSocket tidak aktif. Mencoba menghubungkan ulang...')
      return
    }
    s.setStreaming(true)
    s.setError(null)
    s.setStatus('routing', 'AI sedang menganalisis pertanyaan Anda...')

    // Placeholder AI message that tokens will stream into.
    s.addMessage({
      id: `ai-${Date.now()}`,
      sender: 'ai',
      text: '',
      status: 'routing',
      createdAt: new Date().toISOString(),
    })

    socket.emit('user_message', {
      text: args.text,
      sessionId: args.sessionId,
      userId: args.user.userId,
      companyId: args.user.companyId,
      integrationId: args.integrationId,
    })
  }

  return { connected, sendMessage }
}