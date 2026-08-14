'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface CacheEntry<T> {
  data: T
  at: number
}

// ponytail: module-level (survives unmount/remount, not just re-render) —
// each view component unmounts on menu switch and remounts on return, so a
// per-component ref/state cache would still reset every visit. This is what
// actually kills the repeat skeleton flash: same key, same Map, across visits.
const cache = new Map<string, CacheEntry<unknown>>()

/**
 * Cross-visit cache for a view's fetched data. On first visit, behaves like a
 * normal loading fetch. On a later visit with the same key, renders the
 * previously-cached data immediately (loading=false, no skeleton) while
 * silently refetching in the background — stale-while-revalidate.
 *
 * Call `refresh()` for a user-initiated reload (shows loading state again).
 */
export function useCachedViewData<T>(key: string, fetcher: () => Promise<T>) {
  const cached = cache.get(key) as CacheEntry<T> | undefined
  const [data, setData] = useState<T | null>(cached?.data ?? null)
  const [loading, setLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    setError(null)
    try {
      const result = await fetcherRef.current()
      cache.set(key, { data: result, at: Date.now() })
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error.')
    } finally {
      setLoading(false)
    }
  }, [key])

  useEffect(() => {
    void load({ silent: !!cache.get(key) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { data, loading, error, refresh: () => load() }
}
