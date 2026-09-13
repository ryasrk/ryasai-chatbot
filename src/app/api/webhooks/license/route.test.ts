/**
 * POST /api/webhooks/license — the License-Validator tells this install its license state changed.
 *
 * WHY THIS FILE EXISTS. Same orphan backlog, but this one sits on the REVENUE path: it is the only
 * inbound call that can revoke or restore an entitlement. It is public (no session cookie) and its whole
 * defence is one shared secret, so the properties worth pinning are all about that boundary and about
 * what a forged body is allowed to do.
 *
 *   1. NO SECRET CONFIGURED == NO ACCESS. `if (!expectedSecret || ...)` closes the route when
 *      LICENSE_WEBHOOK_SECRET is unset. Without the `!expectedSecret` half, `secretsMatch(x, undefined)`
 *      decisions would hinge on a comparison against nothing and an unconfigured install would accept
 *      forged revocations. This is the highest-value test in the file.
 *   2. The comparison is TIMING-SAFE and hashes both sides, so neither a prefix match nor a LENGTH
 *      oracle is available. `secretsMatch` is indirect (not exported), so it is exercised through the
 *      route: a correct secret passes, a wrong one of the same length fails, and a PREFIX of the real
 *      secret fails.
 *   3. Only the FOUR documented events map to a status; anything else is 400 and must NOT touch the row.
 *   4. The org is looked up and updated with `bypassOrg` -- the validator speaks about an arbitrary
 *      license key, so there is no org context to scope by. If either were org-scoped the lookup would
 *      filter on undefined and the webhook would silently no-op forever.
 *   5. An unknown license key is a 200 with a message, NOT an error: the validator must not retry-storm
 *      because one install has no matching row.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const SECRET = 'webhook-secret-value'

let org: { id: string } | null = null
let updateError: Error | null = null
const findArgs: Array<Record<string, unknown>> = []
const updateArgs: Array<Record<string, unknown>> = []
const bypassCalls: string[] = []

mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async (fn: () => Promise<unknown>) => {
    bypassCalls.push('bypass')
    return fn()
  },
}))

mock.module('@/lib/session', () => ({
  handleApiError: (e: unknown, msg: string) =>
    Response.json({ error: msg }, { status: 500 }),
}))

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

mock.module('@/lib/db', () => ({
  db: {
    organization: {
      findFirst: async (args: Record<string, unknown>) => {
        findArgs.push(args)
        return org
      },
      update: async (args: Record<string, unknown>) => {
        updateArgs.push(args)
        if (updateError) throw updateError
        return {}
      },
    },
  },
}))

import { POST } from './route'

function call(body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret !== null) headers['x-webhook-secret'] = secret
  return POST(
    new Request('http://localhost/api/webhooks/license', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers,
    }) as never,
  )
}

beforeEach(() => {
  process.env.LICENSE_WEBHOOK_SECRET = SECRET
  org = { id: 'org-1' }
  updateError = null
  findArgs.length = 0
  updateArgs.length = 0
  bypassCalls.length = 0
})

describe('POST /api/webhooks/license — the secret is the whole boundary', () => {
  test('a MISSING secret header is 401 and never reaches the database', async () => {
    const res = await call({ license_key: 'LK-1', event: 'revoked' }, null)
    expect(res.status).toBe(401)
    expect(findArgs).toHaveLength(0)
    expect(updateArgs).toHaveLength(0)
  })

  test('a WRONG secret of the SAME LENGTH is 401', async () => {
    // Same length rules out "it only compares the first byte"; hashing both sides rules out a length
    // oracle. If this ever passes, the timing-safe helper was replaced by `===` on raw strings.
    const wrong = 'x'.repeat(SECRET.length)
    const res = await call({ license_key: 'LK-1', event: 'revoked' }, wrong)
    expect(res.status).toBe(401)
    expect(updateArgs).toHaveLength(0)
  })

  test('a PREFIX of the real secret is 401', async () => {
    // The classic timing-oracle probe: correct bytes, then stop.
    const res = await call({ license_key: 'LK-1', event: 'revoked' }, SECRET.slice(0, 5))
    expect(res.status).toBe(401)
    expect(updateArgs).toHaveLength(0)
  })

  test('an EMPTY secret header is 401', async () => {
    const res = await call({ license_key: 'LK-1', event: 'revoked' }, '')
    expect(res.status).toBe(401)
    expect(updateArgs).toHaveLength(0)
  })

  test('when LICENSE_WEBHOOK_SECRET is UNSET the route refuses EVERYTHING', async () => {
    // `if (!expectedSecret || ...)`. Without the !expectedSecret half an unconfigured install would
    // compare against undefined and accept a forged revocation. Pinned because the failure mode is
    // "fails OPEN", which is invisible until someone abuses it.
    delete process.env.LICENSE_WEBHOOK_SECRET
    const res = await call({ license_key: 'LK-1', event: 'revoked' }, 'anything')
    expect(res.status).toBe(401)
    expect(findArgs).toHaveLength(0)
    expect(updateArgs).toHaveLength(0)
  })

  test('the correct secret is accepted', async () => {
    const res = await call({ license_key: 'LK-1', event: 'revoked' })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/webhooks/license — event mapping', () => {
  test("'revoked' and 'expired' both set licenseStatus=expired", async () => {
    for (const event of ['revoked', 'expired']) {
      updateArgs.length = 0
      const res = await call({ license_key: 'LK-1', event })
      expect(res.status).toBe(200)
      expect(updateArgs[0]!.data).toMatchObject({ licenseStatus: 'expired' })
    }
  })

  test("'suspended' sets licenseStatus=suspended (a distinct state, not expired)", async () => {
    // Collapsing suspended into expired would lose the operator's ability to tell a payment problem from
    // a revocation.
    await call({ license_key: 'LK-1', event: 'suspended' })
    expect(updateArgs[0]!.data).toMatchObject({ licenseStatus: 'suspended' })
  })

  test("'reactivated' and 'updated' both set licenseStatus=valid", async () => {
    for (const event of ['reactivated', 'updated']) {
      updateArgs.length = 0
      await call({ license_key: 'LK-1', event })
      expect(updateArgs[0]!.data).toMatchObject({ licenseStatus: 'valid' })
    }
  })

  test('an UNKNOWN event is 400 and does NOT touch the row', async () => {
    // The route reads the license row before it validates the event, so a sloppy default would let a
    // typo'd event silently rewrite license state.
    const res = await call({ license_key: 'LK-1', event: 'explde' })
    expect(res.status).toBe(400)
    expect(updateArgs).toHaveLength(0)
  })

  test('a plan is written only when supplied', async () => {
    await call({ license_key: 'LK-1', event: 'updated', plan: 'flat' })
    expect(updateArgs[0]!.data).toMatchObject({ licensePlan: 'flat' })

    updateArgs.length = 0
    await call({ license_key: 'LK-1', event: 'updated' })
    expect(updateArgs[0]!.data).not.toHaveProperty('licensePlan')
  })

  test('every accepted event stamps licenseValidatedAt', async () => {
    // Revalidation timing is what the grace period is computed from; a status change without the stamp
    // would make the clock lie.
    await call({ license_key: 'LK-1', event: 'reactivated' })
    expect((updateArgs[0]!.data as { licenseValidatedAt: unknown }).licenseValidatedAt).toBeInstanceOf(Date)
  })
})

describe('POST /api/webhooks/license — body and lookup', () => {
  test('a missing license_key or event is 400', async () => {
    expect((await call({ event: 'revoked' })).status).toBe(400)
    expect((await call({ license_key: 'LK-1' })).status).toBe(400)
    expect(updateArgs).toHaveLength(0)
  })

  test('a malformed body is 400, never a 500', async () => {
    expect((await call('not json')).status).toBe(400)
    expect((await call([1])).status).toBe(400)
  })

  test('an UNKNOWN license key is a 200 no-op, so the validator does not retry-storm', async () => {
    // This install has no row for that key (wrong install, or an already-deleted org). Answering 4xx would
    // make the validator retry forever against every install that is not the intended recipient.
    org = null
    const res = await call({ license_key: 'NOT-MINE', event: 'revoked' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; message: string }
    expect(body.ok).toBe(true)
    expect(updateArgs).toHaveLength(0)
  })

  test('the lookup and the update both run inside bypassOrg', async () => {
    // The validator speaks about an arbitrary license key, so there is no org context. An org-scoped read
    // would filter on undefined, find nothing, and turn every webhook into a silent no-op.
    await call({ license_key: 'LK-1', event: 'revoked' })
    expect(bypassCalls).toHaveLength(2)
    expect(findArgs[0]!.where).toEqual({ licenseKey: 'LK-1' })
    expect(updateArgs[0]!.where).toEqual({ id: 'org-1' })
  })

  test('a database failure surfaces as 500, not a false success', async () => {
    updateError = Object.assign(new Error('db down'), { code: 'P1001' })
    const res = await call({ license_key: 'LK-1', event: 'revoked' })
    expect(res.status).toBe(500)
  })
})
