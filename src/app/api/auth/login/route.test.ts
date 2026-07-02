import { describe, expect, it } from 'bun:test'
import { normalizeLoginInput } from './route'

describe('normalizeLoginInput', () => {
  it('accepts valid input and lowercases email', () => {
    expect(normalizeLoginInput({ email: ' Admin@Acme.com ', password: 'pw' })).toEqual({
      email: 'admin@acme.com',
      password: 'pw',
    })
  })

  it('rejects missing fields', () => {
    expect(normalizeLoginInput({ email: 'a@b.c' })).toBeNull()
    expect(normalizeLoginInput({ password: 'pw' })).toBeNull()
    expect(normalizeLoginInput(null)).toBeNull()
    expect(normalizeLoginInput({ email: '', password: 'pw' })).toBeNull()
  })
})
