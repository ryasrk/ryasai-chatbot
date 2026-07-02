/**
 * useActiveUser — shared active-user context (Zustand-backed).
 * The fetch runs once on mount; `unauthorized` is surfaced so the shell can
 * render the login screen when the session is invalid or missing.
 */
'use client'

import { useEffect } from 'react'
import { useActiveUserStore } from '@/store/useActiveUserStore'

// Module-level boot guard: load the active user exactly once, no matter how
// many components call this hook.
let booted = false

export function useActiveUser() {
  const user = useActiveUserStore((s) => s.user)
  const loading = useActiveUserStore((s) => s.loading)
  const unauthorized = useActiveUserStore((s) => s.unauthorized)
  const refresh = useActiveUserStore((s) => s.refresh)

  useEffect(() => {
    if (booted) return
    booted = true
    refresh()
  }, [refresh])

  return { user, loading, unauthorized, refresh }
}
