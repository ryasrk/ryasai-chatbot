import { describe, expect, it, mock } from 'bun:test'

let appConfigRow: { setupCompleted: boolean } | null = null
let appConfigCalls: unknown[] = []
let appConfigCount = 0
let countCalls: unknown[] = []

mock.module('@/lib/db', () => ({
  db: {
    appConfig: {
      findFirst: async (args: unknown) => {
        appConfigCalls.push(args)
        return appConfigRow
      },
      count: async (args: unknown) => {
        countCalls.push(args)
        return appConfigCount
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

  it('does not read any single AppConfig row pre-login', async () => {
    // appConfigRow simulates some OTHER org's still-incomplete wizard — with no
    // organizationId (no session yet), getSetupState must not read a single row:
    // row ordering would make the answer depend on which org is physically first.
    appConfigRow = { setupCompleted: false }
    appConfigCalls = []
    await getSetupState(db as never)
    expect(appConfigCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Fresh-install gate
// ---------------------------------------------------------------------------
// INCIDENT (2026-09): the pre-login branch used to hardcode
// `setupCompleted: true`. On a genuinely fresh install — 0 users, 0 orgs, 0
// AppConfig rows, exactly what `install.sh` produces before the first signup —
// that told the client setup was already done, so page.tsx skipped its whole
// `if (!setup.setupCompleted)` signup block and rendered the app shell with no
// session. A brand-new customer never received a Sign Up form. Reproduced
// against a clean `prisma db push` database.
//
// The previous test asserted the buggy value directly ("reports
// setupCompleted:true pre-login"), which is why it shipped. The contract is
// now: the anonymous answer means "has ANY setup EVER been completed?", so it
// must be false on an empty database.
describe('getSetupState — fresh install must reach signup', () => {
  it('reports setupCompleted:false when no org has completed setup', async () => {
    appConfigCount = 0
    countCalls = []
    const state = await getSetupState(db as never)
    expect(state.setupCompleted).toBe(false)
    // count() cannot be skewed by row ordering — the original motive for the hardcode.
    expect(countCalls[0]).toMatchObject({ where: { setupCompleted: true } })
  })

  it('reports setupCompleted:true once any org has completed setup', async () => {
    appConfigCount = 1
    const state = await getSetupState(db as never)
    expect(state.setupCompleted).toBe(true)
  })

  it('still reports hasAdmin:false on an empty database', async () => {
    appConfigCount = 0
    const state = await getSetupState(db as never)
    // page.tsx branches on this to choose signup over login.
    expect(state.hasAdmin).toBe(false)
  })

  it('does not consult the anonymous count when an org is known', async () => {
    appConfigRow = { setupCompleted: true }
    countCalls = []
    await getSetupState(db as never, 'org-a')
    expect(countCalls.length).toBe(0)
  })
})
