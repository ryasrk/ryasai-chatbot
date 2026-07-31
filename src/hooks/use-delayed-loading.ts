'use client'

import { useEffect, useState } from 'react'

/**
 * Delays showing a loading state until `delay` ms has elapsed.
 * Fast loads (< delay) skip the skeleton entirely — no flash.
 * ponytail: 200ms is imperceptible to users but eliminates the skeleton flash
 * on loads that resolve in <100ms. Global: set delay=0 to always show instantly.
 */
export function useDelayedLoading(loading: boolean, delay = 200): boolean {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!loading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShow(false)
      return
    }
    const t = setTimeout(() => setShow(true), delay)
    return () => clearTimeout(t)
  }, [loading, delay])

  return show
}
