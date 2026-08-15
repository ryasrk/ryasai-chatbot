import { describe, expect, it, mock } from 'bun:test'

let appConfigRow: { setupCompleted: boolean } | null = null
let appConfigCalls: unknown[] = []

mock.module('@/lib/db', () => ({
  db: {
    appConfig: {
      findFirst: async (args: unknown) => {
        appConfigCalls.push(args)
        return appConfigRow
      },
    },
    user: {
      findFirst: async () => null,
    },
  },
}))

import { normalizeSetupAdminInput, getSetupState } from './setup'
import { db } from '@/lib/db'

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

describe('getSetupState — org scoping', () => {
  // Regression coverage for a bug where getSetupState() was called unscoped
  // (findFirst() with no where) from a public, pre-auth route. In this
  // multi-tenant app every signup creates its own Organization + AppConfig
  // row, so the unscoped call picked up whichever org's row happened to be
  // physically first and reported ITS setupCompleted — an already-onboarded
  // admin in org B got bounced back into the wizard on refresh because org A
  // (an old demo signup, an e2e run, another trial) never finished its own.

  it('scopes the AppConfig lookup to organizationId when a session is known', async () => {
    appConfigRow = { setupCompleted: true }
    appConfigCalls = []
    const state = await getSetupState(db as never, 'org-a')
    expect(appConfigCalls[0]).toMatchObject({ where: { organizationId: 'org-a' } })
    expect(state.setupCompleted).toBe(true)
  })

  it('reports the scoped org is incomplete on its own merits', async () => {
    appConfigRow = { setupCompleted: false }
    const state = await getSetupState(db as never, 'org-b')
    expect(state.setupCompleted).toBe(false)
  })

  it('does not read any AppConfig row and reports setupCompleted:true pre-login', async () => {
    // appConfigRow simulates some OTHER org's still-incomplete wizard — with no
    // organizationId (no session yet), getSetupState must not touch it at all.
    appConfigRow = { setupCompleted: false }
    appConfigCalls = []
    const state = await getSetupState(db as never)
    expect(appConfigCalls.length).toBe(0)
    expect(state.setupCompleted).toBe(true)
  })
})
