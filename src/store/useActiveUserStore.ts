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
  orgName: string | null
  loading: boolean
  /** True when the last /api/me refresh returned 401 (no valid session). */
  unauthorized: boolean
  /** True when the last /api/me refresh returned 402 (license invalid). */
  licenseError: boolean

  refresh: () => Promise<void>
}

export const useActiveUserStore = create<ActiveUserState>((set) => ({
  user: null,
  orgName: null,
  loading: true,
  unauthorized: false,
  licenseError: false,

  refresh: async () => {
    set({ loading: true })
    try {
      const res = await fetch('/api/me', { cache: 'no-store' })
      if (res.ok) {
        const user = await res.json()
        set({ user, unauthorized: false, licenseError: false })
        // Fetch org name in parallel (non-blocking)
        fetch('/api/org', { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null)
          .then(d => set({ orgName: d?.organization?.name ?? null }))
          .catch(() => {})
      } else if (res.status === 401) {
        set({ user: null, orgName: null, unauthorized: true, licenseError: false })
      } else if (res.status === 402) {
        set({ user: null, orgName: null, licenseError: true })
      }
    } catch {
      /* ignore — transient network errors don't change auth state */
    } finally {
      set({ loading: false })
    }
  },
}))
