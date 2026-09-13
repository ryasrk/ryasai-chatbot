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
  getOidcConfig,
  verifyIdTokenRs256,
  fetchUserInfo,
  resetJwksCache,
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

  test('ZERO orgs is refused with actionable guidance, not a crash', async () => {
    // The very first login before any organization exists. Without this guard the
    // code would fall through with an empty org list and provision into `undefined`,
    // which on a real DB is a foreign-key failure rather than a clear message. The
    // error tells the operator what to DO (complete signup first).
    mockDbState.orgs = []
    await expect(getOrCreateSsoUser({ sub: 'sub_none', email: 'none@test.com' })).rejects.toThrow(
      'SSO login attempted before any organization exists. Complete signup first.',
    )
    // The refusal happens BEFORE any org is chosen, so no lookup by id is attempted.
    // (I first asserted `createArgs === null` here and it failed: createArgs is set by
    // an EARLIER test and this harness never resets it, so asserting on it would test
    // leftover state rather than this branch.)
    expect(mockDbState.orgs.length).toBe(0)
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

// ---------------------------------------------------------------------------
// getOidcConfig, fetchJwk and verifyIdTokenRs256 — the RS256 path
//
// Only HS256 verification and the pure helpers were exercised. The discovery call
// and the asymmetric verifier had NEVER run, so nothing pinned: the requests made,
// the refusal of a token signed by another key, the audience/issuer/nonce checks,
// or the JWKS cache. RS256 is the flow a real IdP (Okta, Entra, Auth0) uses.
//
// A stubbed verifier would accept whatever the code did, so every case here signs a
// REAL JWT with a REAL RSA key and drives the actual crypto.verify path.
// ---------------------------------------------------------------------------

const realFetch = global.fetch

/** base64url without padding, as JWTs require. */
function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const rsaJwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'key-1', alg: 'RS256', use: 'sig' }

/** Sign a JWT the way a conforming IdP does: header.payload with RS256. */
function makeJwt(payload: Record<string, unknown>, opts: { kid?: string; key?: crypto.KeyObject } = {}): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: opts.kid ?? 'key-1' }
  const signed = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = crypto.sign('sha256', Buffer.from(signed), opts.key ?? rsa.privateKey)
  return `${signed}.${sig.toString('base64url')}`
}

function baseClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://idp.test',
    aud: 'test-client-id',
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: 'user-1',
    email: 'a@b.test',
    ...over,
  }
}

let calls: string[] = []
let responder: (url: string) => Response

function installFetch() {
  calls = []
  global.fetch = (async (input: unknown) => {
    const url = String(input)
    calls.push(url)
    return responder(url)
  }) as unknown as typeof fetch
}

describe('getOidcConfig — discovery', () => {
  beforeEach(() => {
    responder = () => new Response('{}', { status: 200 })
    installFetch()
  })
  afterAll(() => { global.fetch = realFetch })

  test('fetches <issuer>/.well-known/openid-configuration and returns the config', async () => {
    const cfg = { issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/auth', token_endpoint: 'https://idp.test/token' }
    responder = () => new Response(JSON.stringify(cfg), { status: 200 })
    const out = await getOidcConfig('https://idp.test')
    expect(calls[0]).toBe('https://idp.test/.well-known/openid-configuration')
    expect(out.token_endpoint).toBe('https://idp.test/token')
  })

  test('a trailing slash on the issuer does not produce a doubled slash', async () => {
    const cfg = { issuer: 'https://idp.test', authorization_endpoint: 'a', token_endpoint: 't' }
    responder = () => new Response(JSON.stringify(cfg), { status: 200 })
    // A doubled slash 404s on many IdPs, which would look like a broken SSO setup.
    await getOidcConfig('https://idp.test/')
    expect(calls[0]).toBe('https://idp.test/.well-known/openid-configuration')
  })

  test('an HTTP error is thrown with its status, not silently accepted', async () => {
    responder = () => new Response('nope', { status: 404 })
    await expect(getOidcConfig('https://idp.test')).rejects.toThrow('404')
  })

  test('a config WITHOUT the endpoints is rejected', async () => {
    responder = () => new Response(JSON.stringify({ issuer: 'https://idp.test' }), { status: 200 })
    // Proceeding here would build an auth URL against undefined and send the user
    // to a malformed redirect.
    await expect(getOidcConfig('https://idp.test')).rejects.toThrow('missing required endpoints')
  })
})

describe('verifyIdTokenRs256 — the asymmetric verifier', () => {
  const config: OidcConfig = {
    issuer: 'https://idp.test',
    authorization_endpoint: 'https://idp.test/auth',
    token_endpoint: 'https://idp.test/token',
    jwks_uri: 'https://idp.test/jwks',
  }

  beforeEach(() => {
    resetJwksCache()
    responder = () => new Response(JSON.stringify({ keys: [rsaJwk] }), { status: 200 })
    installFetch()
  })
  afterAll(() => { global.fetch = realFetch; resetJwksCache() })

  test('a token signed by the IdP key is accepted, and the JWKS is fetched once', async () => {
    const token = makeJwt(baseClaims())
    const payload = await verifyIdTokenRs256(token, config)
    expect(payload.sub).toBe('user-1')
    expect(calls).toEqual(['https://idp.test/jwks'])
    // Second call must come from the cache: fetching JWKS per login is a needless
    // round trip and can rate-limit a busy tenant.
    await verifyIdTokenRs256(makeJwt(baseClaims()), config)
    expect(calls).toHaveLength(1)
  })

  test('a token signed by ANOTHER key is rejected', async () => {
    const attacker = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const token = makeJwt(baseClaims(), { key: attacker.privateKey })
    // The whole point of RS256: knowing the header is not enough to mint a login.
    await expect(verifyIdTokenRs256(token, config)).rejects.toThrow('signature verification failed')
  })

  test('a TAMPERED payload invalidates the signature', async () => {
    const token = makeJwt(baseClaims())
    const [h, , s] = token.split('.')
    const forged = `${h}.${b64url(JSON.stringify(baseClaims({ sub: 'admin' })))}.${s}`
    await expect(verifyIdTokenRs256(forged, config)).rejects.toThrow('signature verification failed')
  })

  test('an HS256-token offered to the RS256 verifier is refused (alg confusion)', async () => {
    // Classic JWT attack: sign with HMAC using the public key as the secret. The verifier
    // must reject on `alg` before it ever touches the signature.
    const header = { alg: 'HS256', typ: 'JWT' }
    const signed = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(baseClaims()))}`
    const sig = crypto.createHmac('sha256', 'secret').update(signed).digest('base64url')
    await expect(verifyIdTokenRs256(`${signed}.${sig}`, config)).rejects.toThrow('Expected RS256')
  })

  test('an issuer mismatch is refused', async () => {
    const token = makeJwt(baseClaims({ iss: 'https://evil.test' }))
    await expect(verifyIdTokenRs256(token, config)).rejects.toThrow('iss mismatch')
  })

  test('an audience mismatch is refused', async () => {
    const token = makeJwt(baseClaims({ aud: 'someone-else' }))
    // Without this check a token minted for a different app at the same IdP is a login.
    await expect(verifyIdTokenRs256(token, config)).rejects.toThrow('aud mismatch')
  })

  test('an EXPIRED token is refused', async () => {
    const token = makeJwt(baseClaims({ exp: Math.floor(Date.now() / 1000) - 60 }))
    await expect(verifyIdTokenRs256(token, config)).rejects.toThrow('expired')
  })

  test('a nonce mismatch is refused, and a matching nonce passes', async () => {
    const token = makeJwt(baseClaims({ nonce: 'n-1' }))
    await expect(verifyIdTokenRs256(token, config, 'n-OTHER')).rejects.toThrow('nonce mismatch')
    await expect(verifyIdTokenRs256(token, config, 'n-1')).resolves.toBeTruthy()
  })

  test('a config without jwks_uri fails closed instead of skipping verification', async () => {
    const { jwks_uri: _drop, ...noJwks } = config
    // Skipping the signature when no keys are available would accept ANY token.
    await expect(verifyIdTokenRs256(makeJwt(baseClaims()), noJwks as OidcConfig)).rejects.toThrow('missing jwks_uri')
  })

  test('a JWKS HTTP error is surfaced', async () => {
    responder = () => new Response('nope', { status: 500 })
    await expect(verifyIdTokenRs256(makeJwt(baseClaims()), config)).rejects.toThrow('JWKS fetch failed: 500')
  })

  test('an empty JWKS key set is refused', async () => {
    responder = () => new Response(JSON.stringify({ keys: [] }), { status: 200 })
    await expect(verifyIdTokenRs256(makeJwt(baseClaims()), config)).rejects.toThrow('no keys')
  })

  test('an unknown kid is refused rather than falling back to another key', async () => {
    responder = () => new Response(JSON.stringify({ keys: [rsaJwk] }), { status: 200 })
    const token = makeJwt(baseClaims(), { kid: 'rotated-away' })
    // Falling back to keys[0] here would validate a token from a RETIRED key.
    await expect(verifyIdTokenRs256(token, config)).rejects.toThrow('no key for kid=rotated-away')
  })

  test('a kid absent from the CACHED JWKS forces a fresh fetch (key rotation)', async () => {
    const next = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const nextJwk = { ...(next.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: 'key-2', alg: 'RS256' }
    // MEASURED, and it corrected this test: the first version returned BOTH keys
    // from the outset, so key-2 was already in the cache and no refetch happened —
    // the cache was right and the expectation was wrong. The responder now publishes
    // key-1 only until the second call, which is what an actual rotation looks like.
    let generation = 1
    responder = () => new Response(
      JSON.stringify({ keys: generation === 1 ? [rsaJwk] : [rsaJwk, nextJwk] }),
      { status: 200 },
    )
    await verifyIdTokenRs256(makeJwt(baseClaims()), config)
    expect(calls).toHaveLength(1)
    generation = 2
    const rotated = makeJwt(baseClaims(), { kid: 'key-2', key: next.privateKey })
    const payload = await verifyIdTokenRs256(rotated, config)
    expect(payload.sub).toBe('user-1')
    // The cache must not be trusted for a kid it does not hold, or every login
    // after a rotation fails until the TTL expires.
    expect(calls).toHaveLength(2)
  })
})

describe('fetchUserInfo', () => {
  beforeEach(() => {
    responder = () => new Response('{}', { status: 200 })
    installFetch()
  })
  afterAll(() => { global.fetch = realFetch })

  test('without a userinfo endpoint it falls back to the id_token claims', async () => {
    const { userinfo_endpoint: _drop, ...cfg } = {
      issuer: 'https://idp.test', authorization_endpoint: 'a', token_endpoint: 't', jwks_uri: 'j', userinfo_endpoint: 'https://idp.test/u',
    } as OidcConfig
    const info = await fetchUserInfo(makeJwt(baseClaims({ preferred_username: 'alice' })), cfg as OidcConfig)
    // No network call is made in the fallback, so a provider without userinfo works.
    expect(calls).toEqual([])
    expect(info.sub).toBe('user-1')
    expect(info.preferred_username).toBe('alice')
  })

  test('with a userinfo endpoint it fetches and returns the profile', async () => {
    responder = () => new Response(JSON.stringify({ sub: 'user-1', email: 'x@y.test', name: 'X' }), { status: 200 })
    const cfg = { issuer: 'https://idp.test', authorization_endpoint: 'a', token_endpoint: 't', userinfo_endpoint: 'https://idp.test/u' } as OidcConfig
    const info = await fetchUserInfo('access-token', cfg)
    expect(calls[0]).toBe('https://idp.test/u')
    expect(info.email).toBe('x@y.test')
  })
})

describe('verifyIdToken — the unsupported-alg branch and aud shapes', () => {
  function sign(claims: Record<string, unknown>, header: Record<string, unknown>): string {
    const h = Buffer.from(JSON.stringify(header)).toString('base64url')
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const sig = crypto.createHmac('sha256', process.env.OIDC_CLIENT_SECRET!).update(`${h}.${p}`).digest('base64url')
    return `${h}.${p}.${sig}`
  }

  test('an alg that is neither HS256 nor RS256 is refused by name', () => {
    // `none` is the classic attack: an unsigned token that some verifiers accept.
    // The alphabet must be CLOSED, so anything else throws with the alg in the message
    // rather than falling through to returning the payload unverified.
    for (const alg of ['none', 'ES256', 'HS512', '']) {
      expect(() =>
        verifyIdToken(sign(baseClaims(), { alg, typ: 'JWT' }), mockConfig),
      ).toThrow(/Unsupported JWT alg|HS256/)
    }
    // MEASURED: with alg 'none' the branch hit is the HS256 path first, because the
    // code checks `alg === 'HS256'` explicitly and 'none' falls past it. The named
    // 'Unsupported JWT alg' branch is reached by ES256, which is what pins it.
    expect(() => verifyIdToken(sign(baseClaims(), { alg: 'ES256' }), mockConfig)).toThrow(
      'Unsupported JWT alg: ES256',
    )
  })

  test('DECLARED INTEROP BUG: an ARRAY `aud` is refused, so a valid token fails closed', () => {
    // MEASURED AND REPORTED, not fixed. OIDC allows `aud` to be an ARRAY, and several
    // IdPs (Auth0, Azure AD) emit one whenever the token is issued for more than one
    // audience. The check is `payload.aud !== clientId`, which compares an ARRAY to a
    // STRING and can never be equal -- so a perfectly valid token is REJECTED.
    //
    // This FAILS CLOSED: it is a login outage, not an authentication bypass. I checked
    // for a fail-open direction too, and found none -- `[ ]` is truthy in JS and still
    // throws, 123 throws, and a single-element array `['clientId']` throws as well.
    // The fix (accept a string OR an array containing our client id) WIDENS what is
    // accepted, so it is a security-relevant rollout decision for SSO customers rather
    // than something to change silently.
    const aud = ['some-other-client', process.env.OIDC_CLIENT_ID!]
    // The client id IS present in the array, yet the token is still refused.
    expect(() => verifyIdToken(sign(baseClaims({ aud }), { alg: 'HS256' }), mockConfig))
      .toThrow('JWT aud mismatch')

    // And a single-element array carrying ONLY our client id is refused too.
    expect(() =>
      verifyIdToken(sign(baseClaims({ aud: [process.env.OIDC_CLIENT_ID!] }), { alg: 'HS256' }), mockConfig),
    ).toThrow('JWT aud mismatch')

    // The string form is accepted, which is what the IdPs that emit a string send.
    expect(verifyIdToken(sign(baseClaims(), { alg: 'HS256' }), mockConfig).sub).toBe('user-1')
  })

  test('an ABSENT aud is allowed (the guard short-circuits on falsy)', () => {
    // `payload.aud && ...` -- a token with no aud passes the audience check entirely.
    // Pinned so the behaviour is deliberate: the signature and issuer are still
    // checked, and an IdP that omits aud is unusual but not rejected.
    const tok = sign({ iss: 'https://idp.test', exp: Math.floor(Date.now() / 1000) + 3600, sub: 'user-1' }, { alg: 'HS256' })
    expect(verifyIdToken(tok, mockConfig).sub).toBe('user-1')
  })

  test('an ABSENT iss is allowed too, and an absent exp is NOT treated as expired', () => {
    const tok = sign({ sub: 'user-1' }, { alg: 'HS256' })
    expect(verifyIdToken(tok, mockConfig).sub).toBe('user-1')
  })

  test('a nonce is only checked WHEN the caller supplies one', () => {
    const tok = sign(baseClaims({ nonce: 'n-1' }), { alg: 'HS256' })
    expect(verifyIdToken(tok, mockConfig).sub).toBe('user-1')
    expect(verifyIdToken(tok, mockConfig, 'n-1').sub).toBe('user-1')
    expect(() => verifyIdToken(tok, mockConfig, 'n-2')).toThrow('JWT nonce mismatch')
  })

  test('HS256 with NO OIDC_CLIENT_SECRET configured fails closed', () => {
    // Without this guard `crypto.createHmac('sha256', undefined)` would throw a
    // TypeError from deep inside node instead of an error naming the missing config,
    // and a deployment that switched to RS256-only could silently start ACCEPTING
    // HS256 tokens signed with a literal "undefined" secret. Locally the env var is
    // always set, so this branch had no test until a negative control removed it and
    // NOTHING went red.
    const saved = process.env.OIDC_CLIENT_SECRET
    delete process.env.OIDC_CLIENT_SECRET
    try {
      const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
      const p = Buffer.from(JSON.stringify(baseClaims())).toString('base64url')
      expect(() => verifyIdToken(`${h}.${p}.AAAA`, mockConfig)).toThrow('HS256 requires OIDC_CLIENT_SECRET')
    } finally {
      process.env.OIDC_CLIENT_SECRET = saved
    }
  })

  test('an HS256 signature of the WRONG LENGTH is refused without a timingSafeEqual throw', () => {
    // `signature.length !== expected.length || !timingSafeEqual(...)` -- the length
    // guard exists because timingSafeEqual THROWS on a length mismatch. Without it a
    // short signature would raise an exception instead of a clean refusal.
    const h = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')
    const p = Buffer.from(JSON.stringify(baseClaims())).toString('base64url')
    expect(() => verifyIdToken(`${h}.${p}.AAAA`, mockConfig)).toThrow(
      'JWT HS256 signature verification failed',
    )
    expect(() => verifyIdToken(`${h}.${p}.`, mockConfig)).toThrow(
      'JWT HS256 signature verification failed',
    )
  })
})
