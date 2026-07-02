/**
 * Single source of truth for the active user (tenant context).
 * ----------------------------------------------------------------------------
 * Centralising in a Zustand store means the identity fetched once in the shell
 * is seen identically by every consumer (Topbar, ChatView, Settings). The store
 * is intentionally minimal: a single admin product has no user-switching, so it
 * only tracks `user`, `loading`, an `unauthorized` flag (set when /api/me
 * returns 401 so the shell can render the login screen), and `refresh`.
 */
import { create } from 'zustand'
import type { ActiveUser } from '@/lib/types'

interface ActiveUserState {
  user: ActiveUser | null
  loading: boolean
  /** True when the last /api/me refresh returned 401 (no valid session). */
  unauthorized: boolean

  refresh: () => Promise<void>
}

export const useActiveUserStore = create<ActiveUserState>((set) => ({
  user: null,
  loading: true,
  unauthorized: false,

  refresh: async () => {
    set({ loading: true })
    try {
      const res = await fetch('/api/me', { cache: 'no-store' })
      if (res.ok) {
        set({ user: await res.json(), unauthorized: false })
      } else if (res.status === 401) {
        set({ user: null, unauthorized: true })
      }
    } catch {
      /* ignore — transient network errors don't change auth state */
    } finally {
      set({ loading: false })
    }
  },
}))
