/**
 * Tests for `session-guard`, the helper that turns "this request failed because the session is dead" into a state
 * the app shell understands.
 *
 * WHY THIS EXISTS AT ALL. MEASURED IN UAT: an expired session made the AI-configuration form render with an EMPTY
 * model field and no message while the header still showed a logged-in user. The cause was that each view fetched
 * independently and swallowed its own error; the store's `unauthorized` flag — which the shell already uses to show
 * the login screen — was never told. A real user reported the symptom as "the model I picked disappeared".
 */
import { describe, expect, test } from 'bun:test'
import { classifySessionFailure, handleSessionFailure } from './session-guard'
import { useActiveUserStore } from '@/store/useActiveUserStore'

describe('classifySessionFailure — only session failures count', () => {
  test('401 is unauthenticated, 402 is licence', () => {
    expect(classifySessionFailure({ status: 401 })).toBe('unauthenticated')
    expect(classifySessionFailure({ status: 402 })).toBe('license')
  })

  test('200, 400, 403, 500 and network-ish codes are NOT session failures', () => {
    /*
     * THE DIRECTION THAT MATTERS. A transient 500 or a 403 must never log the user out: a 500 means the SERVER has
     * a problem, and a 403 means THIS ACTION is not allowed while the session is perfectly valid. Treating either as
     * "session dead" would kick a working user back to the login screen because one endpoint misbehaved.
     */
    for (const status of [200, 201, 204, 400, 403, 404, 409, 422, 429, 500, 502, 503]) {
      expect(`${status}:${classifySessionFailure({ status })}`).toBe(`${status}:null`)
    }
  })
})

describe('handleSessionFailure — records the state the shell reacts to', () => {
  test('a 401 marks the store unauthorized so the login screen can render', async () => {
    useActiveUserStore.setState({ user: null, unauthorized: false, licenseError: false })
    // The caller uses the return value to short-circuit; TRUE means "stop, nothing more to do here".
    expect(await handleSessionFailure({ status: 401 })).toBe(true)
    expect(useActiveUserStore.getState().unauthorized).toBe(true)
  })

  test('a 500 leaves the session alone and tells the caller to carry on', async () => {
    // The opposite direction, and the one that would regress silently: if this returned true, a single server error
    // would blank the user's identity.
    useActiveUserStore.setState({ user: { userId: 'u1' } as never, unauthorized: false, licenseError: false })
    expect(await handleSessionFailure({ status: 500 })).toBe(false)
    expect(useActiveUserStore.getState().unauthorized).toBe(false)
    expect(useActiveUserStore.getState().user).not.toBeNull()
  })

  test('a 402 sets licenseError, not unauthorized — they render different screens', async () => {
    useActiveUserStore.setState({ unauthorized: false, licenseError: false })
    expect(await handleSessionFailure({ status: 402 })).toBe(true)
    const s = useActiveUserStore.getState()
    expect(s.licenseError).toBe(true)
    // Mixing these would show "sign in" to a user whose licence merely expired — a dead end, since signing in
    // cannot fix a licence.
    expect(s.unauthorized).toBe(false)
  })
})
