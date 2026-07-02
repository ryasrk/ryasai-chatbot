import { describe, expect, it } from 'bun:test'
import { normalizeSetupAdminInput } from './setup'

describe('normalizeSetupAdminInput', () => {
  it('accepts valid input', () => {
    expect(
      normalizeSetupAdminInput({ name: 'Admin', email: ' A@B.co ', password: 'longenough' }),
    ).toEqual({ name: 'Admin', email: 'a@b.co', password: 'longenough' })
  })
  it('rejects short passwords', () => {
    expect(normalizeSetupAdminInput({ name: 'A', email: 'a@b.co', password: 'short' })).toBeNull()
  })
  it('rejects missing fields', () => {
    expect(normalizeSetupAdminInput({})).toBeNull()
    expect(normalizeSetupAdminInput(null)).toBeNull()
  })
})
