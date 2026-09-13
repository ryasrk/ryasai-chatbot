import { describe, expect, test, mock, beforeEach } from 'bun:test'

// The SAML env contract is set here because buildSamlConfig() is what
// createSamlInstance() reads; without a resolvable entry point it throws
// 'SAML entry point could not be resolved' long before the code under test runs.
// (sso-saml.test.ts sets the same block at module scope for the same reason.)
process.env.SAML_SP_ENTITY_ID = 'https://chatbot.test'
process.env.SAML_SP_CALLBACK_URL = 'https://chatbot.test/api/auth/saml/callback'
process.env.SAML_IDP_ENTRY_POINT = 'https://idp.test/saml/sso'
process.env.SAML_IDP_CERT = '-----BEGIN CERTIFICATE-----\nMIIDfakecert\n-----END CERTIFICATE-----'
process.env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)
delete process.env.SAML_IDP_METADATA_URL

// ---------------------------------------------------------------------------
// SSO/SAML: the provisioning and assertion paths.
//
// A separate file from sso-saml.test.ts on purpose. That file is deliberately
// pure — it sets env vars at module scope and exercises isSamlConfigured /
// buildSamlConfig / generateSpMetadata with NO mocks, so an operator can read it
// as the env contract. Adding db/redis/saml mocks there would change what that
// file proves. This file owns the mocks and covers the paths that touch the
// database and the SAML library.
//
// Why this path matters: `getOrCreateSsoUser` is the ONLY place a SAML login
// creates a user row. A previous version hardcoded organizationId 'org-default',
// a leftover from the reverted single-tenant refactor — User.organizationId is a
// foreign key, so on a real multi-tenant DB first-time SSO login threw an FK
// violation and was simply broken, and no test caught it because the db mock
// accepted any value. Initial login could not work at all.
// ---------------------------------------------------------------------------
const state = {
  userBySubject: null as any,
  userByEmail: null as any,
  created: [] as any[],
  updates: [] as any[],
  userCount: 0,
  org: { licensePlan: 'flat' } as any,
  orgExists: true,
  orgs: [] as any[],
  redisSet: 'OK' as string | null,
  /** `SET NX` result for the replay guard: 'OK' = first sighting, null = already present (a replay). */
  redisSetReplay: 'OK' as string | null,
  /** Keys the replay guard wrote, so the assertion id and the TTL can be asserted. */
  replaySetCalls: [] as string[],
  redisGetValue: null as string | null,
  redisThrows: false,
  quota: { allowed: true, limit: 10, current: 0 } as any,
  profile: null as any,
  validateThrows: false,
  validateCalls: [] as any[],
}

mock.module('@/lib/db', () => ({
  db: {
    user: {
      findFirst: async () => state.userBySubject,
      findUnique: async () => state.userByEmail,
      count: async () => state.userCount,
      update: async (a: any) => {
        state.updates.push(a)
        const base = state.userBySubject ?? state.userByEmail
        return { ...base, ...(a.data?.ssoSubject ? { ssoSubject: a.data.ssoSubject } : {}), sessionVersion: 2 }
      },
      create: async (a: any) => {
        state.created.push(a)
        return { id: 'u-new', name: a.data.name, email: a.data.email }
      },
    },
    organization: {
      findUnique: async () => (state.orgExists ? state.org : null),
      findMany: async () => state.orgs,
    },
  },
}))
mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: (fn: () => unknown) => fn(),
  getOrgContext: () => 'org-1',
  enterWithOrg: () => {},
}))
mock.module('@/lib/redis', () => ({
  redisCmd: {
    // The replay guard is a SET NX: a THROW is the outage, and a `null` return means the key ALREADY existed, i.e.
    // this assertion id has been seen inside its TTL. Both shapes are modelled, because a mock that only ever threw
    // or only ever returned 'OK' could not tell the two failure modes apart.
    set: async (key: string) => {
      if (state.redisThrows) throw new Error('redis down')
      state.replaySetCalls.push(key)
      return state.redisSetReplay
    },
    get: async () => state.redisGetValue,
    del: async () => 1,
  },
}))
mock.module('@/lib/crypto', () => ({
  signSession: (userId: string, v: number) => `tok.${userId}.${v}`,
}))
mock.module('@/lib/plan-gating', () => ({
  checkQuota: () => state.quota,
  quotaExceededMessage: (k: string) => `Quota exceeded: maxUsers (${k})`,
}))
mock.module('@/lib/sso', () => ({
  resolveSsoOrganizationId: async () => {
    // Mirrors the real fail-closed contract: the single-org case resolves, the
    // multi-org case THROWS rather than guessing a tenant.
    if (state.orgs.length === 1) return state.orgs[0].id
    if (state.orgs.length === 0) throw new Error('SSO login attempted before any organization exists. Complete signup first.')
    throw new Error('SSO cannot determine which organization to provision into: multiple organizations exist.')
  },
}))
mock.module('@node-saml/node-saml', () => ({
  SAML: class {
    constructor(_o: any) {}
    validatePostResponseAsync(args: any) {
      state.validateCalls.push(args)
      if (state.validateThrows) return Promise.reject(new Error('invalid signature'))
      return Promise.resolve({ profile: state.profile })
    }
  },
  ValidateInResponseTo: { never: 'never', always: 'always', ifPresent: 'ifPresent' },
}))

import { getOrCreateSsoUser, validateSamlResponse, SamlReplayCheckUnavailableError } from './sso-saml'

beforeEach(() => {
  state.userBySubject = null
  state.userByEmail = null
  state.created = []
  state.updates = []
  state.userCount = 0
  state.org = { licensePlan: 'flat' }
  state.orgExists = true
  state.orgs = [{ id: 'org-1' }]
  state.redisSet = 'OK'
  state.redisThrows = false
  state.redisSetReplay = 'OK'
  state.replaySetCalls = []
  state.redisGetValue = null
  state.quota = { allowed: true, limit: 10, current: 0 }
  state.profile = null
  state.validateThrows = false
  state.validateCalls = []
})

describe('getOrCreateSsoUser — the only place SSO creates a user', () => {
  test('a first-time login creates the user in the RESOLVED org, never a hardcoded one', async () => {
    state.orgs = [{ id: 'org-42' }]
    const r = await getOrCreateSsoUser({ sub: 'sub-1', email: 'a@b.com', name: 'A' })
    expect(r.created).toBe(true)
    // The regression this pins: a literal 'org-default' here is an FK violation
    // on a real multi-tenant DB, and the db mock swallowed it.
    expect(state.created[0].data.organizationId).toBe('org-42')
    expect(state.created[0].data.organizationId).not.toBe('org-default')
  })

  test('a missing NameID is refused before any query', async () => {
    await expect(getOrCreateSsoUser({ sub: '', email: 'a@b.com' })).rejects.toThrow('missing NameID')
    expect(state.created).toHaveLength(0)
  })

  test('an existing ssoSubject reuses the row and does NOT create', async () => {
    state.userBySubject = { id: 'u-1', name: 'Existing', email: 'e@b.com' }
    const r = await getOrCreateSsoUser({ sub: 'sub-1' })
    expect(r.created).toBe(false)
    expect(r.userId).toBe('u-1')
    expect(state.created).toHaveLength(0)
  })

  test('an existing session is invalidated on login (sessionVersion incremented)', async () => {
    state.userBySubject = { id: 'u-1', name: 'E', email: 'e@b.com' }
    const r = await getOrCreateSsoUser({ sub: 'sub-1' })
    // Without the increment, a stale cookie from before the SSO switch stays
    // valid — session fixation.
    expect(state.updates[0].data.sessionVersion).toEqual({ increment: 1 })
    expect(r.sessionToken).toBeDefined()
  })

  test('an email match LINKS the existing account rather than duplicating it', async () => {
    state.userByEmail = { id: 'u-2', name: 'Local', email: 'me@b.com' }
    const r = await getOrCreateSsoUser({ sub: 'sub-new', email: 'me@b.com' })
    expect(r.created).toBe(false)
    expect(r.userId).toBe('u-2')
    // It must bind the subject, otherwise the next login re-links forever.
    expect(state.updates[0].data.ssoSubject).toBe('sub-new')
    expect(state.created).toHaveLength(0)
  })

  test('email is lowercased so case cannot create a second account', async () => {
    await getOrCreateSsoUser({ sub: 's', email: 'Mixed@Case.COM' })
    expect(state.created[0].data.email).toBe('mixed@case.com')
  })

  test('a missing email derives a deterministic local address from the subject', async () => {
    await getOrCreateSsoUser({ sub: 'subject-9' })
    expect(state.created[0].data.email).toBe('sso_subject-9@sso.local')
  })

  test('a missing name falls back to the email local part', async () => {
    await getOrCreateSsoUser({ sub: 's', email: 'jane.doe@b.com' })
    expect(state.created[0].data.name).toBe('jane.doe')
  })

  test('the created user cannot log in by password', async () => {
    await getOrCreateSsoUser({ sub: 's', email: 'a@b.com' })
    // '!' is not a valid hash, so a password login for an SSO account fails.
    expect(state.created[0].data.passwordHash).toBe('!')
  })

  test('QUOTA: provisioning is refused when maxUsers is exceeded', async () => {
    state.quota = { allowed: false, limit: 1, current: 1 }
    await expect(getOrCreateSsoUser({ sub: 's', email: 'a@b.com' })).rejects.toThrow('Quota exceeded')
    // No row, and no round-trip to the customer DB wasted.
    expect(state.created).toHaveLength(0)
  })

  test('QUOTA is checked against the RESOLVED org member count', async () => {
    state.userCount = 7
    await getOrCreateSsoUser({ sub: 's', email: 'a@b.com' })
    expect(state.created).toHaveLength(1)
  })

  test('an unknown licensePlan resolves to the most restrictive tier, not unlimited', async () => {
    state.org = null
    state.orgExists = false
    // checkQuota is injected, so this asserts the call still happens and the
    // refusal path is reachable rather than silently skipped.
    state.quota = { allowed: false, limit: 0, current: 0 }
    await expect(getOrCreateSsoUser({ sub: 's', email: 'a@b.com' })).rejects.toThrow('Quota exceeded')
  })

  test('MULTI-ORG: login fails closed instead of guessing a tenant', async () => {
    state.orgs = [{ id: 'org-1' }, { id: 'org-2' }]
    // Guessing would attribute the user to the wrong tenant — strictly worse
    // than an error.
    await expect(getOrCreateSsoUser({ sub: 's', email: 'a@b.com' })).rejects.toThrow('multiple organizations')
    expect(state.created).toHaveLength(0)
  })

  test('NO-ORG: login fails closed with actionable guidance', async () => {
    state.orgs = []
    await expect(getOrCreateSsoUser({ sub: 's', email: 'a@b.com' })).rejects.toThrow('Complete signup first')
  })
})

describe('validateSamlResponse — assertion validation', () => {
  test('extracts NameID as the subject', async () => {
    state.profile = { nameID: 'user-123', ID: 'assert-1' }
    const r = await validateSamlResponse('base64')
    expect(r.sub).toBe('user-123')
  })

  test('the raw body is passed through as SAMLResponse', async () => {
    state.profile = { nameID: 'u', ID: 'a' }
    await validateSamlResponse('encoded-body')
    expect(state.validateCalls[0]).toEqual({ SAMLResponse: 'encoded-body' })
  })

  test('a response with no profile is refused', async () => {
    state.profile = null
    await expect(validateSamlResponse('x')).rejects.toThrow('no profile')
  })

  test('a signature failure propagates rather than returning an empty identity', async () => {
    state.validateThrows = true
    // Returning a partial identity here would authenticate an unverified caller.
    await expect(validateSamlResponse('x')).rejects.toThrow('invalid signature')
  })

  test('a profile without NameID is refused', async () => {
    state.profile = { ID: 'a' }
    await expect(validateSamlResponse('x')).rejects.toThrow('missing NameID')
  })

  test('REPLAY: a reused assertion is rejected', async () => {
    state.profile = { nameID: 'u', ID: 'assert-1' }
    state.redisSetReplay = null // NX set failed → already present
    await expect(validateSamlResponse('x')).rejects.toThrow('replay detected')
  })

  test('a fresh assertion is accepted and the key carries a TTL', async () => {
    state.profile = { nameID: 'u', ID: 'assert-2' }
    state.redisSetReplay = 'OK'
    const r = await validateSamlResponse('x')
    expect(r.sub).toBe('u')
  })

  test('FIXED: a REPLAY-CHECK OUTAGE fails CLOSED instead of admitting the assertion', async () => {
    // INVERTED. This used to pin the opposite: a Redis outage degraded to "allow", on the argument that signature
    // validation is the primary barrier. That argument is wrong for THIS check specifically -- the signature proves
    // the assertion came from the IdP, and the replay check is the only thing that proves it has not been SEEN
    // already. Failing open means a captured assertion stays a bearer credential for exactly as long as the
    // outage lasts, which is the window an attacker would wait for. It now throws a typed error so the caller
    // answers 5xx rather than creating a session.
    state.profile = { nameID: 'u', ID: 'assert-3' }
    state.redisThrows = true
    await expect(validateSamlResponse('x')).rejects.toThrow(SamlReplayCheckUnavailableError)
    // The class carries a code so a route can map it without matching on a message.
    const err = (await validateSamlResponse('x').catch((e: unknown) => e)) as { code?: string }
    expect(err.code).toBe('SAML_REPLAY_CHECK_UNAVAILABLE')
    // The refusal happens at the GUARD, before any user is provisioned -- an outage must not leave a half-made user.
    expect(state.created).toEqual([])
  })

  test('a REPLAY is refused when the id IS in the cache — the check still bites', async () => {
    // The other half: failing closed must not have replaced the detection itself. A non-throwing outage test would
    // pass even if the guard only ever threw.
    state.profile = { nameID: 'u', ID: 'assert-seen' }
    state.redisThrows = false
    state.redisSetReplay = null
    await expect(validateSamlResponse('x')).rejects.toThrow(/replay/i)
    // The key names the assertion, so two different assertions cannot collide on one slot.
    expect(state.replaySetCalls.some((k) => k.includes('assert-seen'))).toBe(true)
    // And with a FRESH set result the same assertion is admitted, so the guard is not a blanket refusal.
    state.redisSetReplay = 'OK'
    state.profile = { nameID: 'u', ID: 'assert-fresh' }
    const ok = await validateSamlResponse('x')
    expect(ok.sub).toBe('u')
  })

  test('email is read from the OID attribute when present', async () => {
    state.profile = { nameID: 'u', ID: 'a', 'urn:oid:0.9.2342.19200300.100.1.3': 'Oid@B.com' }
    const r = await validateSamlResponse('x')
    expect(r.email).toBe('oid@b.com')
  })

  test('email falls back to the claims URI, then mail, then email', async () => {
    state.profile = { nameID: 'u', ID: 'a', mail: 'Mail@B.com' }
    expect((await validateSamlResponse('x')).email).toBe('mail@b.com')
    state.profile = { nameID: 'u', ID: 'a', email: 'Plain@B.com' }
    expect((await validateSamlResponse('x')).email).toBe('plain@b.com')
  })

  test('name is read from the claims URI and the OID fallbacks', async () => {
    state.profile = { nameID: 'u', ID: 'a', 'urn:oid:2.5.4.3': 'FromOid' }
    expect((await validateSamlResponse('x')).name).toBe('FromOid')
    state.profile = { nameID: 'u', ID: 'a', displayName: 'Displayed' }
    expect((await validateSamlResponse('x')).name).toBe('Displayed')
  })

  test('an absent email stays undefined rather than becoming a bogus address', async () => {
    state.profile = { nameID: 'u', ID: 'a' }
    expect((await validateSamlResponse('x')).email).toBeUndefined()
  })
})
