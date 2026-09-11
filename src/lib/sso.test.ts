import { describe, expect, test, beforeEach, mock, afterAll } from 'bun:test'
import crypto from 'crypto'

process.env.OIDC_ISSUER = 'https://idp.test'
process.env.OIDC_CLIENT_ID = 'test-client-id'
process.env.OIDC_CLIENT_SECRET = 'test-client-secret'
process.env.OIDC_REDIRECT_URI = 'https://app.test/api/auth/sso/callback'
process.env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)

const mockDbState = {
  findFirstResult: null as any,
  findUniqueResult: null as any,
  createResult: { id: 'user_new', name: 'Test', email: 'test@test.com' } as any,
  createArgs: null as any,
  updateResult: { id: 'user_1', sessionVersion: 2, name: 'Test', email: 'test@test.com' } as any,
  // SSO provisioning now resolves the target org and enforces maxUsers. Defaults
  // describe the normal single-org self-hosted case on 'flat' (uncapped enough
  // for these tests).
  orgs: [{ id: 'org_1', name: 'Acme' }] as Array<{ id: string; name: string }>,
  orgLookup: { id: 'org_1', licensePlan: 'flat' } as any,
  userCount: 1,
}

mock.module('@/lib/db', () => ({
  db: {
    user: {
      findFirst: () => Promise.resolve(mockDbState.findFirstResult),
      findUnique: () => Promise.resolve(mockDbState.findUniqueResult),
      create: (args: any) => {
        mockDbState.createArgs = args
        return Promise.resolve(mockDbState.createResult)
      },
      update: () => Promise.resolve(mockDbState.updateResult),
      count: () => Promise.resolve(mockDbState.userCount),
    },
    organization: {
      findMany: () => Promise.resolve(mockDbState.orgs),
      findUnique: () => Promise.resolve(mockDbState.orgLookup),
    },
  },
}))

import {
  isOidcConfigured,
  buildAuthUrl,
  decodeIdToken,
  verifyIdToken,
  exchangeCode,
  getOrCreateSsoUser,
  generateStateNonce,
  generateCodeVerifier,
  computeCodeChallenge,
  type OidcConfig,
} from './sso'

const mockConfig: OidcConfig = {
  issuer: 'https://idp.test',
  authorization_endpoint: 'https://idp.test/auth',
  token_endpoint: 'https://idp.test/token',
  userinfo_endpoint: 'https://idp.test/userinfo',
  jwks_uri: 'https://idp.test/jwks',
}

const originalFetch = globalThis.fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('isOidcConfigured', () => {
  test('returns true when all required env vars are set', () => {
    expect(isOidcConfigured()).toBe(true)
  })

  test('returns false when OIDC_ISSUER is missing', () => {
    const saved = process.env.OIDC_ISSUER
    delete process.env.OIDC_ISSUER
    expect(isOidcConfigured()).toBe(false)
    process.env.OIDC_ISSUER = saved
  })

  test('returns false when OIDC_CLIENT_ID is missing', () => {
    const saved = process.env.OIDC_CLIENT_ID
    delete process.env.OIDC_CLIENT_ID
    expect(isOidcConfigured()).toBe(false)
    process.env.OIDC_CLIENT_ID = saved
  })

  test('returns false when OIDC_REDIRECT_URI is missing', () => {
    const saved = process.env.OIDC_REDIRECT_URI
    delete process.env.OIDC_REDIRECT_URI
    expect(isOidcConfigured()).toBe(false)
    process.env.OIDC_REDIRECT_URI = saved
  })

  test('returns false when env var is empty string', () => {
    const saved = process.env.OIDC_ISSUER
    process.env.OIDC_ISSUER = '  '
    expect(isOidcConfigured()).toBe(false)
    process.env.OIDC_ISSUER = saved
  })
})

describe('buildAuthUrl', () => {
  test('builds correct URL with required params', () => {
    const { state, nonce } = generateStateNonce()
    const url = buildAuthUrl(mockConfig, state, nonce)
    expect(url).toContain('https://idp.test/auth?')
    expect(url).toContain('response_type=code')
    expect(url).toContain('client_id=test-client-id')
    expect(url).toContain(`state=${state}`)
    expect(url).toContain(`nonce=${nonce}`)
    expect(url).toContain('scope=openid+profile+email')
  })

  test('includes PKCE params when codeChallenge provided', () => {
    const { state, nonce } = generateStateNonce()
    const challenge = computeCodeChallenge('test-verifier')
    const url = buildAuthUrl(mockConfig, state, nonce, challenge)
    expect(url).toContain('code_challenge=')
    expect(url).toContain('code_challenge_method=S256')
  })

  test('omits PKCE params when codeChallenge not provided', () => {
    const { state, nonce } = generateStateNonce()
    const url = buildAuthUrl(mockConfig, state, nonce)
    expect(url).not.toContain('code_challenge')
  })

  test('throws when OIDC_CLIENT_ID not set', () => {
    const saved = process.env.OIDC_CLIENT_ID
    delete process.env.OIDC_CLIENT_ID
    expect(() => buildAuthUrl(mockConfig, 's', 'n')).toThrow('OIDC_CLIENT_ID')
    process.env.OIDC_CLIENT_ID = saved
  })
})

describe('decodeIdToken', () => {
  function makeJwt(payload: Record<string, unknown>, alg = 'HS256'): string {
    const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = Buffer.from('fake-sig').toString('base64url')
    return `${header}.${body}.${sig}`
  }

  test('decodes valid JWT', () => {
    const token = makeJwt({ sub: 'user123', email: 'test@test.com' })
    const { header, payload } = decodeIdToken(token)
    expect(header.alg).toBe('HS256')
    expect(payload.sub).toBe('user123')
    expect(payload.email).toBe('test@test.com')
  })

  test('throws on non-3-part JWT', () => {
    expect(() => decodeIdToken('notajwt')).toThrow('expected 3 parts')
  })

  test('throws on invalid base64', () => {
    expect(() => decodeIdToken('a.b.c')).toThrow()
  })
})

describe('verifyIdToken (HS256)', () => {
  function makeSignedJwt(payload: Record<string, unknown>, secret: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const signedData = `${header}.${body}`
    const sig = crypto.createHmac('sha256', secret).update(signedData).digest()
    return `${signedData}.${sig.toString('base64url')}`
  }

  test('valid HS256 token passes', () => {
    const token = makeSignedJwt({
      iss: 'https://idp.test',
      aud: 'test-client-id',
      sub: 'user123',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, 'test-client-secret')
    const payload = verifyIdToken(token, mockConfig)
    expect(payload.sub).toBe('user123')
  })

  test('expired token throws', () => {
    const token = makeSignedJwt({
      iss: 'https://idp.test',
      aud: 'test-client-id',
      exp: Math.floor(Date.now() / 1000) - 3600,
    }, 'test-client-secret')
    expect(() => verifyIdToken(token, mockConfig)).toThrow('expired')
  })

  test('wrong issuer throws', () => {
    const token = makeSignedJwt({
      iss: 'https://wrong.test',
      aud: 'test-client-id',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, 'test-client-secret')
    expect(() => verifyIdToken(token, mockConfig)).toThrow('iss mismatch')
  })

  test('wrong audience throws', () => {
    const token = makeSignedJwt({
      iss: 'https://idp.test',
      aud: 'wrong-client',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, 'test-client-secret')
    expect(() => verifyIdToken(token, mockConfig)).toThrow('aud mismatch')
  })

  test('wrong nonce throws', () => {
    const token = makeSignedJwt({
      iss: 'https://idp.test',
      aud: 'test-client-id',
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce: 'expected-nonce',
    }, 'test-client-secret')
    expect(() => verifyIdToken(token, mockConfig, 'different-nonce')).toThrow('nonce mismatch')
  })

  test('wrong signature throws', () => {
    const token = makeSignedJwt({
      iss: 'https://idp.test',
      aud: 'test-client-id',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }, 'wrong-secret')
    expect(() => verifyIdToken(token, mockConfig)).toThrow('signature verification failed')
  })

  test('RS256 token throws (must use verifyIdTokenRs256)', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({ iss: 'https://idp.test' })).toString('base64url')
    const token = `${header}.${body}.fakesig`
    expect(() => verifyIdToken(token, mockConfig)).toThrow('verifyIdTokenRs256')
  })
})

describe('exchangeCode', () => {
  test('sends correct token exchange request with code_verifier', async () => {
    let capturedBody = ''
    let capturedUrl = ''
    globalThis.fetch = ((url: string, opts: any) => {
      capturedUrl = url
      capturedBody = String(opts.body)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          access_token: 'at',
          id_token: 'header.payload.sig',
          token_type: 'Bearer',
        }),
      })
    }) as any

    const tokens = await exchangeCode('mycode', mockConfig, 'my-verifier')
    expect(capturedUrl).toBe('https://idp.test/token')
    expect(capturedBody).toContain('grant_type=authorization_code')
    expect(capturedBody).toContain('code=mycode')
    expect(capturedBody).toContain('code_verifier=my-verifier')
    expect(capturedBody).toContain('client_id=test-client-id')
    expect(capturedBody).toContain('client_secret=test-client-secret')
    expect(tokens.id_token).toBe('header.payload.sig')
  })

  test('throws when response missing id_token', async () => {
    globalThis.fetch = (() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ access_token: 'at', token_type: 'Bearer' }),
    })) as any

    expect(exchangeCode('code', mockConfig)).rejects.toThrow('missing id_token')
  })

  test('throws on non-ok response', async () => {
    globalThis.fetch = (() => Promise.resolve({
      ok: false,
      status: 400,
      text: () => Promise.resolve('invalid_grant'),
    })) as any

    expect(exchangeCode('bad', mockConfig)).rejects.toThrow('token exchange failed')
  })
})

describe('getOrCreateSsoUser', () => {
  beforeEach(() => {
    mockDbState.findFirstResult = null
    mockDbState.findUniqueResult = null
    mockDbState.createResult = { id: 'user_new', name: 'Test', email: 'test@test.com' }
    mockDbState.updateResult = { id: 'user_1', sessionVersion: 2, name: 'Test', email: 'test@test.com' }
  })

  test('throws when sub is missing', async () => {
    expect(getOrCreateSsoUser({ sub: '' })).rejects.toThrow('missing sub')
  })

  test('updates existing user found by ssoSubject', async () => {
    mockDbState.findFirstResult = {
      id: 'user_1', name: 'Existing', email: 'existing@test.com', ssoSubject: 'sub123',
    }
    mockDbState.updateResult = { id: 'user_1', sessionVersion: 2 }

    const result = await getOrCreateSsoUser({ sub: 'sub123', email: 'existing@test.com', name: 'Existing' })
    expect(result.userId).toBe('user_1')
    expect(result.created).toBe(false)
  })

  test('links existing user found by email', async () => {
    mockDbState.findFirstResult = null
    mockDbState.findUniqueResult = {
      id: 'user_2', name: 'ByEmail', email: 'byemail@test.com',
    }
    mockDbState.updateResult = { id: 'user_2', name: 'ByEmail', email: 'byemail@test.com', sessionVersion: 2 }

    const result = await getOrCreateSsoUser({ sub: 'sub456', email: 'byemail@test.com', name: 'ByEmail' })
    expect(result.userId).toBe('user_2')
    expect(result.created).toBe(false)
  })

  test('creates new user when not found', async () => {
    mockDbState.findFirstResult = null
    mockDbState.findUniqueResult = null
    mockDbState.createResult = { id: 'user_new', name: 'New', email: 'new@test.com' }

    const result = await getOrCreateSsoUser({ sub: 'sub789', email: 'new@test.com', name: 'New' })
    expect(result.userId).toBe('user_new')
    expect(result.created).toBe(true)
  })

  test('uses fallback email when not provided', async () => {
    mockDbState.findFirstResult = null
    mockDbState.findUniqueResult = null
    mockDbState.createResult = { id: 'user_sso', name: 'SSOUser', email: '' }
    // Re-mock keeps `organization` + `user.count` — provisioning resolves the
    // target org and checks maxUsers before creating, so an incomplete stub
    // here would fail for the wrong reason.
    mock.module('@/lib/db', () => ({
      db: {
        user: {
          findFirst: () => Promise.resolve(mockDbState.findFirstResult),
          findUnique: () => Promise.resolve(mockDbState.findUniqueResult),
          count: () => Promise.resolve(mockDbState.userCount),
          create: (args: any) => Promise.resolve({
            id: 'user_sso', name: 'SSOUser', email: args.data.email,
          }),
          update: () => Promise.resolve(mockDbState.updateResult),
        },
        organization: {
          findMany: () => Promise.resolve(mockDbState.orgs),
          findUnique: () => Promise.resolve(mockDbState.orgLookup),
        },
      },
    }))

    const result = await getOrCreateSsoUser({ sub: 'sub999' })
    expect(result.email).toContain('sso_')
    expect(result.email).toContain('@sso.local')
  })
})

describe('SSO org resolution + maxUsers quota', () => {
  // Regression: provisioning used to write the literal 'org-default'. That is a
  // foreign key on User.organizationId, so on a real DB the insert threw and
  // first-time SSO login was broken — invisible to a mocked `db`.
  beforeEach(() => {
    mockDbState.findFirstResult = null
    mockDbState.findUniqueResult = null
    mockDbState.createResult = { id: 'user_new', name: 'Test', email: 'test@test.com' }
    mockDbState.orgs = [{ id: 'org_1', name: 'Acme' }]
    mockDbState.orgLookup = { id: 'org_1', licensePlan: 'flat' }
    mockDbState.userCount = 1
    delete process.env.SSO_ORGANIZATION_ID
  })

  test('provisions into the resolved org, never the literal org-default', async () => {
    mockDbState.createResult = { id: 'user_new', name: 'Test', email: 'test@test.com' }
    await getOrCreateSsoUser({ sub: 'sub_fk', email: 'fk@test.com' })
    expect(mockDbState.createArgs.data.organizationId).toBe('org_1')
    expect(mockDbState.createArgs.data.organizationId).not.toBe('org-default')
  })

  test('throws rather than guessing when multiple orgs exist', async () => {
    mockDbState.orgs = [
      { id: 'org_1', name: 'A' },
      { id: 'org_2', name: 'B' },
    ]
    await expect(getOrCreateSsoUser({ sub: 'sub_amb', email: 'amb@test.com' })).rejects.toThrow(
      /multiple organizations/i,
    )
  })

  test('SSO_ORGANIZATION_ID selects the org explicitly', async () => {
    process.env.SSO_ORGANIZATION_ID = 'org_1'
    await getOrCreateSsoUser({ sub: 'sub_explicit', email: 'explicit@test.com' })
    expect(mockDbState.createArgs.data.organizationId).toBe('org_1')
  })

  test('a dangling SSO_ORGANIZATION_ID fails loudly', async () => {
    process.env.SSO_ORGANIZATION_ID = 'org_missing'
    mockDbState.orgLookup = null
    await expect(getOrCreateSsoUser({ sub: 'sub_bad', email: 'bad@test.com' })).rejects.toThrow(
      /no such organization/i,
    )
  })

  test('refuses to provision past the maxUsers ceiling', async () => {
    // starter.maxUsers = 3
    mockDbState.orgLookup = { id: 'org_1', licensePlan: 'starter' }
    mockDbState.userCount = 3
    await expect(getOrCreateSsoUser({ sub: 'sub_over', email: 'over@test.com' })).rejects.toThrow(
      /allows up to 3 users/i,
    )
  })

  test('still provisions when under the ceiling', async () => {
    mockDbState.orgLookup = { id: 'org_1', licensePlan: 'starter' }
    mockDbState.userCount = 2
    mockDbState.createResult = { id: 'user_ok', name: 'Ok', email: 'ok@test.com' }
    const result = await getOrCreateSsoUser({ sub: 'sub_ok', email: 'ok@test.com' })
    expect(result.created).toBe(true)
  })

  test('quota is NOT checked for an existing user (login, not growth)', async () => {
    // An org already at its limit must still let existing members log in.
    mockDbState.orgLookup = { id: 'org_1', licensePlan: 'starter' }
    mockDbState.userCount = 99
    mockDbState.findFirstResult = { id: 'user_1', name: 'Existing', email: 'e@test.com' }
    const result = await getOrCreateSsoUser({ sub: 'sub_existing', email: 'e@test.com' })
    expect(result.created).toBe(false)
    expect(result.userId).toBe('user_1')
  })
})

describe('generateStateNonce + generateCodeVerifier', () => {
  test('returns non-empty strings', () => {
    const { state, nonce } = generateStateNonce()
    expect(state.length).toBeGreaterThan(0)
    expect(nonce.length).toBeGreaterThan(0)
  })

  test('returns different values each call', () => {
    const a = generateStateNonce()
    const b = generateStateNonce()
    expect(a.state).not.toBe(b.state)
    expect(a.nonce).not.toBe(b.nonce)
  })

  test('code verifier is non-empty and different each call', () => {
    const a = generateCodeVerifier()
    const b = generateCodeVerifier()
    expect(a.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })

  test('code challenge is deterministic for same verifier', () => {
    const v = 'test-verifier'
    expect(computeCodeChallenge(v)).toBe(computeCodeChallenge(v))
  })

  test('code challenge differs for different verifiers', () => {
    expect(computeCodeChallenge('a')).not.toBe(computeCodeChallenge('b'))
  })
})
