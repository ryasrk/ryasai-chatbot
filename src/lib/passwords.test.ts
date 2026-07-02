import { describe, expect, it } from 'bun:test'
import { hashPassword, verifyPassword } from './passwords'

describe('passwords', () => {
  it('verifies a correct password', () => {
    const stored = hashPassword('s3cret-pw')
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('s3cret-pw', stored)).toBe(true)
  })

  it('rejects a wrong password', () => {
    expect(verifyPassword('wrong', hashPassword('s3cret-pw'))).toBe(false)
  })

  it('produces unique salts', () => {
    expect(hashPassword('x')).not.toBe(hashPassword('x'))
  })

  it('rejects malformed stored values without throwing', () => {
    expect(verifyPassword('x', 'demo-bcrypt-placeholder')).toBe(false)
    expect(verifyPassword('x', '')).toBe(false)
    expect(verifyPassword('x', 'scrypt$not-base64$$$')).toBe(false)
  })
})
