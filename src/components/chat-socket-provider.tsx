/**
 * ChatSocketProvider — hoists the socket.io connection to the app shell so it
 * survives view transitions. Previously `useChatSocket()` lived inside ChatView,
 * which is wrapped in <AnimatePresence mode="wait">, so every navigation
 * unmounted/recreated the socket. Now it connects once and persists.
 */
'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useChatSocket } from '@/hooks/use-chat-socket'

type ChatSocketValue = ReturnType<typeof useChatSocket>

const ChatSocketContext = createContext<ChatSocketValue | null>(null)

export function ChatSocketProvider({ children }: { children: ReactNode }) {
  const value = useChatSocket()
  return (
    <ChatSocketContext.Provider value={value}>
      {children}
    </ChatSocketContext.Provider>
  )
}

/** Access the single shared chat socket. Must be used within ChatSocketProvider. */
export function useChatSocketContext(): ChatSocketValue {
  const ctx = useContext(ChatSocketContext)
  if (!ctx) {
    throw new Error('useChatSocketContext must be used within <ChatSocketProvider>')
  }
  return ctx
}
