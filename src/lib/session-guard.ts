/**
 * Detecting a DEAD SESSION from any client fetch.
 *
 * WHY THIS EXISTS. MEASURED in UAT: an expired session made the AI-configuration form render with an EMPTY model
 * field and NO error, while the header still showed a logged-in user. An admin concludes their configuration was
 * lost — which is exactly how a real user reported it ("setelah model dipilih lalu pindah menu dan kembali, model
 * pilihan kosong"). The cause was not configuration at all: `ai-configuration-view.tsx` fetched `/api/llm-config`,
 * the response was 401, `llm?.ok` was falsy so `setCfg` was never called, and the `.catch(() => {})` swallowed the
 * reason. The form then rendered from unset state.
 *
 * The store already knows how to represent this — `unauthorized: true` makes the shell render the login screen. The
 * gap was that a 401 from ANY OTHER endpoint never reached it: each view fetched independently and each swallowed
 * its own error. One helper, used by every view, is the fix; a per-view patch would leave the next view to
 * reinvent the same silent failure.
 *
 * WHY 401 SPECIFICALLY, and not every error: a network blip or a 500 must NOT log the user out. Only "your session
 * is not valid" clears identity. 402 is handled the same way the store already handles it (licence), and every
 * other status is left to the caller so it can show an inline error.
 */

/** Statuses that mean "the session itself is the problem", not "this request failed". */
export type SessionFailure = 'unauthenticated' | 'license' | null

/**
 * Classify a response. Returns null when the response is fine OR the failure is not about the session, so callers
 * can `if (fail) return` and otherwise proceed to their own error handling.
 */
export function classifySessionFailure(res: Pick<Response, 'status'>): SessionFailure {
  if (res.status === 401) return 'unauthenticated'
  if (res.status === 402) return 'license'
  return null
}

/**
 * Record a dead session in the shared store so the app shell reacts consistently.
 *
 * Imported lazily inside the function: this module is used by client components, and a static import of the store
 * would pull it into any module that only wants `classifySessionFailure` (including tests that run without a DOM).
 */
export async function noteSessionFailure(kind: Exclude<SessionFailure, null>): Promise<void> {
  const { useActiveUserStore } = await import('@/store/useActiveUserStore')
  const set = useActiveUserStore.setState
  if (kind === 'unauthenticated') {
    set({ user: null, orgName: null, unauthorized: true, licenseError: false })
  } else {
    set({ user: null, orgName: null, licenseError: true, unauthorized: false })
  }
}

/**
 * The whole check in one call, for the common shape in a view:
 *
 *     const res = await fetch('/api/llm-config', { cache: 'no-store' })
 *     if (await handleSessionFailure(res)) return   // shell shows login; nothing more to do here
 *     const data = await res.json()
 *
 * Returns TRUE when the caller should stop, which keeps the call sites to one line and makes the "I forgot to check
 * the status" mistake visible in review.
 */
export async function handleSessionFailure(res: Pick<Response, 'status'>): Promise<boolean> {
  const kind = classifySessionFailure(res)
  if (!kind) return false
  await noteSessionFailure(kind)
  return true
}
