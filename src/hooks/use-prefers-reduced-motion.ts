import { useSyncExternalStore } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function subscribe(cb: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener('change', cb)
  return () => mql.removeEventListener('change', cb)
}

// ponytail: framer-motion's own useReducedMotion logs a console warning in dev
// whenever the OS setting is on, even though we already honor it. Same signal,
// no noise. Server snapshot is false so SSR and first client render match.
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches, () => false)
}
