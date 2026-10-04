import { describe, expect, test } from 'bun:test'
import { sessionActivityExpired } from './session-activity'
import { SESSION_INACTIVITY_TIMEOUT_MS as idle } from './constants'

const now = 1_800_000_000_000
const token = (issuedAt: number) => `user.7.${issuedAt}.verified-signature`
describe('session activity expiry', () => {
  test('missing Redis activity cannot reset an old signed session clock', () => {
    expect(sessionActivityExpired(null, token(now - idle - 1), now)).toBe(true)
    expect(sessionActivityExpired(null, token(now - idle), now)).toBe(true)
    expect(sessionActivityExpired(null, token(now - idle + 1), now)).toBe(false)
  })
  test('recent activity keeps an older session alive; stale activity expires it', () => {
    expect(sessionActivityExpired(String(now - 100), token(now - idle * 2), now)).toBe(false)
    expect(sessionActivityExpired(String(now - idle), token(now - 100), now)).toBe(true)
  })
  test('small Redis clock skew does not log out a recently active user', () => {
    expect(sessionActivityExpired(String(now + 705), token(now - 239), now)).toBe(false)
    expect(sessionActivityExpired(String(now + 5_000), token(now - 239), now)).toBe(false)
    expect(sessionActivityExpired(null, token(now + 225), now)).toBe(false)
    expect(sessionActivityExpired(null, token(now + 5_000), now)).toBe(false)
    expect(sessionActivityExpired(null, token(now + 5_001), now)).toBe(true)
  })
  test('corrupt, excessive future and legacy evidence cannot grant access', () => {
    for (const value of ['', 'garbage', 'Infinity', 'NaN', '0', String(now + 5_001)]) {
      expect(sessionActivityExpired(value, token(now), now)).toBe(true)
    }
    expect(sessionActivityExpired(null, 'legacy.7.signature', now)).toBe(true)
  })
})
