'use client'

import { useEffect, useState } from 'react'
import { getStoredTheme } from '@/lib/themes'

/**
 * True when the Neo-Olympian theme is active. False during SSR and the
 * initial client render (avoids a hydration mismatch, matching the same
 * client-only-read pattern used elsewhere for theme state), then updates
 * live if the user switches themes in Settings — views stay mounted across
 * menu switches in this app, so a stale read here would show Greek-motif
 * icons under a theme that no longer matches.
 */
export function useIsNeoOlympian(): boolean {
  const [isNeoOlympian, setIsNeoOlympian] = useState(false)

  useEffect(() => {
    const check = () => setIsNeoOlympian(getStoredTheme() === 'slate')
    check()
    window.addEventListener('ryasai-theme-changed', check)
    return () => window.removeEventListener('ryasai-theme-changed', check)
  }, [])

  return isNeoOlympian
}
