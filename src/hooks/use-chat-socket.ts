/**
 * useChatSocket — socket.io client hook for the streaming chat protocol (spec §5.2).
 * Connects to the mini-service on port 3003 via the Caddy gateway
 * (`/?XTransformPort=3003`, path `/`).
 */
'use client'

import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { useChatStore } from '@/store/useChatStore'
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

  useEffect(() => {
    const socket = io('/?XTransformPort=3003', {
      path: '/',
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    })
    socketRef.current = socket

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))
    socket.on('connect_error', () => setConnected(false))

    socket.on('status_update', (payload: { status: string; message?: string }) => {
      store.setStatus(payload.status, payload.message)
    })

    socket.on('text_stream', (payload: { token: string }) => {
      store.updateLastAiMessage(payload.token)
    })

    socket.on('message_complete', (payload: { text_final: string; citations?: any[]; chartData?: any }) => {
      store.finalizeLastAiMessage(payload)
    })

    return () => {
      socket.removeAllListeners()
      socket.disconnect()
    }
  }, [])

  async function sendMessage(args: SendMessageArgs) {
    const socket = socketRef.current
    if (!socket || !connected) {
      store.setError('Koneksi WebSocket tidak aktif. Mencoba menghubungkan ulang...')
      return
    }
    store.setStreaming(true)
    store.setError(null)
    store.setStatus('routing', 'AI sedang menganalisis pertanyaan Anda...')

    // Placeholder AI message that tokens will stream into.
    store.addMessage({
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
