/**
 * useActiveUser — fetches & caches the active user, exposes a switcher.
 * Used by the topbar user menu and by every view that needs tenant context.
 */
'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ActiveUser } from '@/lib/types'

export function useActiveUser() {
  const [user, setUser] = useState<ActiveUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [companyUsers, setCompanyUsers] = useState<ActiveUser[]>([])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/me', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setUser(data)
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false)
    }
  }, [])

  const loadCompanyUsers = useCallback(async () => {
    try {
      const res = await fetch('/api/me/users', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        // API returns { items: [...] } OR a bare array — handle both.
        const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
        setCompanyUsers(list)
      }
    } catch {
      /* ignore */
    }
  }, [])

  const switchUser = useCallback(async (userId: string) => {
    const res = await fetch('/api/me', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    })
    if (res.ok) {
      const data = await res.json()
      // Fallback: also set the cookie client-side. Some headless/proxied
      // environments don't persist Set-Cookie from fetch responses, but
      // document.cookie always works for same-origin non-httpOnly cookies.
      try {
        document.cookie = `x-active-user=${encodeURIComponent(JSON.stringify({
          userId: data.userId,
          companyId: data.companyId,
          role: data.role,
          name: data.name,
          email: data.email,
        }))};path=/;max-age=${60 * 60 * 24 * 7};samesite=lax`
      } catch {
        /* ignore */
      }
      setUser(data)
      return data
    }
    return null
  }, [])

  useEffect(() => {
    refresh()
    loadCompanyUsers()
  }, [refresh, loadCompanyUsers])

  return { user, loading, companyUsers, refresh, switchUser }
}
