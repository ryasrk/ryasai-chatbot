/**
 * license-issue.ts had ZERO tests while producing the licence that the on-prem
 * revenue depends on. Every branch below is money-state: the order is already
 * marked settled by the webhook before this runs, so a wrong return value here
 * either loses a paid licence or retries one that is already issued.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- Mocks (must be before the import of the module under test) ---
type Order = {
  id: string
  months: number
  status: string
  licenseKeyIssued: string | null
  organization: { id: string; slug: string | null } | null
}

let orderRow: Order | null = null
const orderUpdates: Array<Record<string, unknown>> = []
const orgUpdates: Array<Record<string, unknown>> = []
const bypassScopes: number[] = []

mock.module('@/lib/db', () => ({
  db: {
    order: {
      findUnique: async () => orderRow,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        orderUpdates.push(data)
        return data
      },
    },
    organization: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        orgUpdates.push(data)
        return data
      },
    },
  },
}))

// The real bypassOrg is a ONE-argument callback wrapper. Mocking it with the
// right arity matters: a 2-arg mock would read a parameter no caller sends.
mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async <T>(fn: () => Promise<T>): Promise<T> => {
    bypassScopes.push(1)
    return fn()
  },
}))

const mockValidateLicense = mock(
  async (_key: string, _machineId: string) => ({
    signatureVerified: true,
    valid: true,
    message: 'ok',
  }),
)
const mockGenerateMachineId = mock((slug: string) => `${slug}:test-host`)
const mockLicenseStatusFromResult = mock(() => 'valid')
type LicenseUpdate = { licenseStatus: string; licensePlan?: string }
const mockLicenseUpdateFromResult = mock(
  (..._args: unknown[]): LicenseUpdate => ({ licenseStatus: 'valid', licensePlan: 'flat' }),
)

mock.module('@/lib/license-client', () => ({
  validateLicense: mockValidateLicense,
  generateMachineId: mockGenerateMachineId,
  licenseStatusFromResult: mockLicenseStatusFromResult,
  licenseUpdateFromResult: mockLicenseUpdateFromResult,
}))

const queueAdds: Array<Record<string, unknown>> = []
let queueThrows = false
mock.module('@/lib/redis', () => ({
  jobQueue: {
    add: async (name: string, data: unknown, opts: unknown) => {
      if (queueThrows) throw new Error('redis down')
      queueAdds.push({ name, data, opts })
      return { id: 'job-1' }
    },
  },
}))

const logs: Array<{ level: string; msg: string }> = []
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({
    info: (m: string) => logs.push({ level: 'info', msg: m }),
    warn: (m: string) => logs.push({ level: 'warn', msg: m }),
    error: (m: string) => logs.push({ level: 'error', msg: m }),
  }),
}))

const { issueLicenseForOrder, licenseIssueBackoffDelayMs, enqueueLicenseIssueRetry,
        LICENSE_ISSUE_MAX_ATTEMPTS, LICENSE_ISSUE_BACKOFF_TYPE } = await import('./license-issue')

function settledOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'ord-1', months: 12, status: 'settlement', licenseKeyIssued: null,
    organization: { id: 'org-1', slug: 'acme' }, ...over,
  }
}

const fetchCalls: Array<{ url: string; init: RequestInit }> = []
function mockFetchOk(body: unknown, ok = true, status = 200) {
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init })
    return { ok, status, json: async () => body } as unknown as Response
  }
}

beforeEach(() => {
  orderRow = settledOrder()
  orderUpdates.length = 0
  orgUpdates.length = 0
  bypassScopes.length = 0
  queueAdds.length = 0
  logs.length = 0
  fetchCalls.length = 0
  queueThrows = false
  mockValidateLicense.mockClear()
  mockGenerateMachineId.mockClear()
  mockLicenseStatusFromResult.mockClear()
  mockLicenseUpdateFromResult.mockClear()
  mockValidateLicense.mockImplementation(async () => ({ signatureVerified: true, valid: true, message: 'ok' }))
  mockLicenseStatusFromResult.mockImplementation(() => 'valid')
  mockLicenseUpdateFromResult.mockImplementation(() => ({ licenseStatus: 'valid', licensePlan: 'flat' }))
  process.env.LICENSE_INTERNAL_SECRET = 'shhh'
  process.env.LICENSE_VALIDATOR_URL = 'http://validator.test'
  process.env.LICENSE_PRODUCT = 'ryasai-chatbot'
  mockFetchOk({ licenseKey: 'LIC-ABC', expiresAt: '2030-01-01T00:00:00Z' })
})

// ---------------------------------------------------------------------------
// Idempotency — the sweep re-runs this constantly
// ---------------------------------------------------------------------------
describe('issueLicenseForOrder — idempotency', () => {
  test('an unknown order is a retryable failure', async () => {
    orderRow = null
    const r = await issueLicenseForOrder('ord-x')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('not found')
  })

  test('a NOT-settled order is ok and does nothing', async () => {
    orderRow = settledOrder({ status: 'pending' })
    const r = await issueLicenseForOrder('ord-1')
    // ok:true because there is nothing to do — a retry would loop forever on an
    // order the user has not paid for yet.
    expect(r.ok).toBe(true)
    expect(fetchCalls).toHaveLength(0)
    expect(orderUpdates).toHaveLength(0)
  })

  test('an order that already has a key does NOT generate a second one', async () => {
    orderRow = settledOrder({ licenseKeyIssued: 'LIC-EXISTING' })
    const r = await issueLicenseForOrder('ord-1')
    expect(r.ok).toBe(true)
    // A second key would leave the customer holding a licence that the validator
    // has also, separately, issued — and burn a second machine slot.
    expect(fetchCalls).toHaveLength(0)
    expect(orderUpdates).toHaveLength(0)
  })

  test('a key present but NO slug still proceeds (cannot shortcut)', async () => {
    orderRow = settledOrder({ licenseKeyIssued: 'LIC-EXISTING', organization: { id: 'org-1', slug: null } })
    const r = await issueLicenseForOrder('ord-1')
    // The idempotency guard requires BOTH, so this falls through to the slug
    // check and fails loudly rather than silently reporting success.
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('slug')
  })
})

// ---------------------------------------------------------------------------
// Fail-closed prerequisites
// ---------------------------------------------------------------------------
describe('issueLicenseForOrder — fail-closed prerequisites', () => {
  test('a missing LICENSE_INTERNAL_SECRET is a retryable failure, not a silent skip', async () => {
    delete process.env.LICENSE_INTERNAL_SECRET
    const r = await issueLicenseForOrder('ord-1')
    // Fail CLOSED: issuing an unsigned licence would be worse than retrying.
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('LICENSE_INTERNAL_SECRET')
    expect(fetchCalls).toHaveLength(0)
    expect(logs.some((l) => l.level === 'error')).toBe(true)
  })

  test('a missing organization slug is a retryable failure', async () => {
    orderRow = settledOrder({ organization: { id: 'org-1', slug: null } })
    const r = await issueLicenseForOrder('ord-1')
    expect(r.ok).toBe(false)
    expect(fetchCalls).toHaveLength(0)
  })

  test('an order with NO organization relation fails rather than throwing', async () => {
    orderRow = settledOrder({ organization: null })
    // Reading order.organization.slug on null would throw; the guard must come first.
    const r = await issueLicenseForOrder('ord-1')
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The generate call
// ---------------------------------------------------------------------------
describe('issueLicenseForOrder — the generate call', () => {
  test('the request carries the internal secret, product, slug and months', async () => {
    await issueLicenseForOrder('ord-1')
    expect(fetchCalls).toHaveLength(1)
    const call = fetchCalls[0]
    expect(call.url).toContain('/internal/licenses/generate')
    const headers = call.init.headers as Record<string, string>
    // Without this header the validator must reject us; if it ever stopped being
    // sent, an unauthenticated caller could mint licences.
    expect(headers['X-Internal-Secret']).toBe('shhh')
    const body = JSON.parse(call.init.body as string)
    expect(body).toEqual({ product: 'ryasai-chatbot', slug: 'acme', months: 12 })
  })

  test('a trailing slash on the validator URL does not double up', async () => {
    process.env.LICENSE_VALIDATOR_URL = 'http://validator.test/'
    await issueLicenseForOrder('ord-1')
    expect(fetchCalls[0].url).toBe('http://validator.test/internal/licenses/generate')
  })


  test('a non-ok response is retryable and stores nothing', async () => {
    mockFetchOk({}, false, 500)
    const r = await issueLicenseForOrder('ord-1')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('500')
    // Nothing may be persisted from a failed generate.
    expect(orderUpdates).toHaveLength(0)
    expect(orgUpdates).toHaveLength(0)
  })

  test('a response without a licenseKey is retryable and stores nothing', async () => {
    mockFetchOk({ expiresAt: '2030-01-01T00:00:00Z' })
    const r = await issueLicenseForOrder('ord-1')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('licenseKey')
    expect(orderUpdates).toHaveLength(0)
  })

  test('a thrown fetch (timeout/refused) is retryable', async () => {
    ;(globalThis as unknown as { fetch: unknown }).fetch = async () => { throw new Error('ECONNREFUSED') }
    const r = await issueLicenseForOrder('ord-1')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('generate request failed')
  })

  test('the generate call has a timeout so a hung validator cannot pin the worker', async () => {
    await issueLicenseForOrder('ord-1')
    expect(fetchCalls[0].init.signal).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Persistence ordering — the key must never be lost
// ---------------------------------------------------------------------------
describe('issueLicenseForOrder — persistence', () => {
  test('the key is stored BEFORE validation runs', async () => {
    const order: string[] = []
    mockValidateLicense.mockImplementation(async () => {
      order.push('validate')
      return { signatureVerified: true, valid: true, message: 'ok' }
    })
    const dbMod = await import('@/lib/db')
    const origOrderUpdate = dbMod.db.order.update
    const origOrgUpdate = dbMod.db.organization.update
    dbMod.db.order.update = (async ({ data }: { data: Record<string, unknown> }) => {
      order.push('store-key')
      return data
    }) as typeof origOrderUpdate
    dbMod.db.organization.update = (async ({ data }: { data: Record<string, unknown> }) => {
      order.push('org-update')
      return data
    }) as typeof origOrgUpdate
    try {
      await issueLicenseForOrder('ord-1')
      // Key durably stored before the validator is asked anything, so a
      // validation hiccup can never lose a licence the customer paid for.
      expect(order.indexOf('store-key')).toBeLessThan(order.indexOf('validate'))
    } finally {
      dbMod.db.order.update = origOrderUpdate
      dbMod.db.organization.update = origOrgUpdate
    }
  })

  test('the provisional write stores the key and the plan', async () => {
    await issueLicenseForOrder('ord-1')
    expect(orderUpdates[0]).toEqual({ licenseKeyIssued: 'LIC-ABC' })
    expect(orgUpdates[0].licenseKey).toBe('LIC-ABC')
    expect(orgUpdates[0].licensePlan).toBe('flat')
    expect(orgUpdates[0].licenseExpiresAt).toBeInstanceOf(Date)
  })

  test('a generate response with no expiresAt leaves expiry untouched', async () => {
    mockFetchOk({ licenseKey: 'LIC-ABC' })
    await issueLicenseForOrder('ord-1')
    // `undefined` means "do not touch" in Prisma — an accidental null would wipe
    // an expiry an admin had set.
    expect(orgUpdates[0].licenseExpiresAt).toBeUndefined()
  })

  test('the final status comes from the SHARED helper, not a local guess', async () => {
    await issueLicenseForOrder('ord-1')
    // The inlined copy of this logic once defaulted plan to 'flat' while the other
    // three call sites did not, which is why the helper is now the single source.
    expect(mockLicenseUpdateFromResult).toHaveBeenCalledTimes(1)
    const [result, opts] = mockLicenseUpdateFromResult.mock.calls[0] as unknown as [unknown, { planFallback: string }]
    expect(opts.planFallback).toBe('flat')
    expect(result).toBeDefined()
    expect(orgUpdates.at(-1)?.licenseStatus).toBe('valid')
  })

  test('the machine id is derived from the org slug', async () => {
    await issueLicenseForOrder('ord-1')
    expect(mockGenerateMachineId).toHaveBeenCalledWith('acme')
    const calls = mockValidateLicense.mock.calls as unknown as Array<[string, string]>
    expect(calls[0][1]).toBe('acme:test-host')
    expect(calls[0][0]).toBe('LIC-ABC')
  })

  test('every DB call runs inside bypassOrg (webhooks have no request context)', async () => {
    await issueLicenseForOrder('ord-1')
    // The webhook that triggers this has no tenant ALS context; without bypassOrg
    // the queries would fail the tenant guard.
    expect(bypassScopes.length).toBeGreaterThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// Post-issue validation failure — the grace-period path
// ---------------------------------------------------------------------------
describe('issueLicenseForOrder — post-issue validation failure', () => {
  test('a validation throw marks the org unreachable but still returns ok', async () => {
    mockValidateLicense.mockImplementation(async () => { throw new Error('validator unreachable') })
    const r = await issueLicenseForOrder('ord-1')
    // ok:true is deliberate. The key IS stored; retrying would mint a second one.
    // 'unreachable' + grace period is the correct state to wait in.
    expect(r.ok).toBe(true)
    expect(orgUpdates.at(-1)).toEqual({ licenseStatus: 'unreachable' })
    expect(logs.some((l) => l.level === 'warn')).toBe(true)
  })

  test('the key is still on the order when validation fails', async () => {
    mockValidateLicense.mockImplementation(async () => { throw new Error('boom') })
    await issueLicenseForOrder('ord-1')
    expect(orderUpdates[0].licenseKeyIssued).toBe('LIC-ABC')
  })

  test('the persisted status is whatever the SHARED helper returns', async () => {
    // The status written to the org comes from licenseUpdateFromResult, NOT from
    // licenseStatusFromResult — the latter is only used for the log line. Asserting
    // on the helper is asserting on the real source of truth; mocking
    // licenseStatusFromResult alone changes nothing that is persisted.
    mockLicenseUpdateFromResult.mockImplementation(() => ({ licenseStatus: 'unreachable' }))
    await issueLicenseForOrder('ord-1')
    expect(orgUpdates.at(-1)?.licenseStatus).toBe('unreachable')
  })

  test('the log line reports the status derived from the signed result', async () => {
    mockLicenseStatusFromResult.mockImplementation(() => 'expired')
    await issueLicenseForOrder('ord-1')
    expect(logs.some((l) => l.level === 'info' && l.msg.includes('expired'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Backoff — pure function, drives ~2h of retries
// ---------------------------------------------------------------------------
describe('licenseIssueBackoffDelayMs', () => {
  test('grows exponentially from 30s', () => {
    expect(licenseIssueBackoffDelayMs(1)).toBe(30_000)
    expect(licenseIssueBackoffDelayMs(2)).toBe(60_000)
    expect(licenseIssueBackoffDelayMs(3)).toBe(120_000)
  })

  test('is capped at 15 minutes', () => {
    // Uncapped, attempt 10 would be ~4 hours and outlive the hourly sweep that
    // is supposed to rescue it.
    expect(licenseIssueBackoffDelayMs(10)).toBe(15 * 60 * 1000)
    expect(licenseIssueBackoffDelayMs(99)).toBe(15 * 60 * 1000)
  })

  test('attempt 0 or a negative attempt does not produce a fraction', () => {
    // 2 ** -1 would give 15s; the clamp keeps the first retry at the base delay.
    expect(licenseIssueBackoffDelayMs(0)).toBe(30_000)
    expect(licenseIssueBackoffDelayMs(-5)).toBe(30_000)
  })

  test('the named backoff type and attempt cap are the documented values', () => {
    expect(LICENSE_ISSUE_BACKOFF_TYPE).toBe('license-issue-backoff')
    expect(LICENSE_ISSUE_MAX_ATTEMPTS).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// Enqueue — must never take down the caller
// ---------------------------------------------------------------------------
describe('enqueueLicenseIssueRetry', () => {
  test('enqueues with the attempt cap and named backoff', async () => {
    await enqueueLicenseIssueRetry('ord-1')
    expect(queueAdds).toHaveLength(1)
    expect(queueAdds[0].name).toBe('license-issue')
    expect(queueAdds[0].data).toEqual({ type: 'license-issue', orderId: 'ord-1' })
    const opts = queueAdds[0].opts as { attempts: number; backoff: { type: string } }
    expect(opts.attempts).toBe(LICENSE_ISSUE_MAX_ATTEMPTS)
    expect(opts.backoff.type).toBe(LICENSE_ISSUE_BACKOFF_TYPE)
  })

  test('a Redis failure is swallowed', async () => {
    queueThrows = true
    // The hourly order-reconcile sweep re-runs the issue regardless, so a queue
    // outage must not surface as an error to the webhook handler.
    await expect(enqueueLicenseIssueRetry('ord-1')).resolves.toBeUndefined()
    expect(logs.some((l) => l.level === 'error')).toBe(true)
  })
})
