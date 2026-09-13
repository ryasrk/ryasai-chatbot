import { describe, expect, test, mock } from 'bun:test'

// ponytail: each *.test.ts runs in its own bun subprocess (mock.module leaks
// across files in one process). Mock the DB/tenant/notification deps so this
// test only exercises the pure eligibility logic + message building.
// Swappable DB so the ORCHESTRATION (runLicenseExpiryReminders) can be driven too.
// The original mock was `{ db: {} }`, which made the whole run entry point
// untestable -- it was 47.73% executable with the scan, the per-org channel
// lookup, the update and the failure branch all unreached. This is a REVENUE
// feature: a silent failure here means a paying customer is never warned before
// their on-prem license expires.
const state = {
  orgs: [] as Record<string, unknown>[],
  cfg: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  updateRejects: false,
  notify: async () => ({ ok: true, latencyMs: 1 }) as { ok: boolean; latencyMs?: number; error?: string },
  bypassCalls: 0,
}
/** Captures the payload handed to the notification sender. */
const mockSendCapture: Array<(a: unknown) => void> = []

const mockOrgFindMany = mock(async (_a?: unknown) => state.orgs)
const mockCfgFindFirst = mock(async (_a?: unknown) => state.cfg)
const mockCfgUpdate = mock(async (a: Record<string, unknown>) => { state.updates.push(a); return {} })
mock.module('./db', () => ({
  db: {
    organization: { findMany: mockOrgFindMany },
    notificationConfig: { findFirst: mockCfgFindFirst, update: mockCfgUpdate },
  },
}))
mock.module('./prisma-tenant', () => ({
  bypassOrg: async <T>(fn: () => T) => { state.bypassCalls++; return fn() },
  enterWithOrg: () => {},
}))
mock.module('./notifications', () => ({
  sendNotificationWithRetry: (a: unknown) => {
    for (const cap of mockSendCapture) cap(a)
    return state.notify() as never
  },
}))
// logSwallowed must return a real function: the production code CALLS it to build
// the .catch handler, so a missing export would throw before the update is even
// attempted.
mock.module('./logger', () => ({
  logSwallowed: (_label: string) => () => {},
}))

const { shouldNotifyDaysLeft, filterReminderOrgs, buildReminderMessage, runLicenseExpiryReminders } = await import('./license-reminder')

const NOW = new Date('2026-08-26T09:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function org(expiresAt: Date | null, extra: Partial<{ id: string; name: string; slug: string; licensePlan: string | null }> = {}) {
  return {
    id: 'org-1',
    name: 'Acme',
    slug: 'acme',
    licensePlan: 'flat',
    licenseExpiresAt: expiresAt,
    ...extra,
  }
}

describe('shouldNotifyDaysLeft — once-per-day dedupe rule', () => {
  test('notifies exactly at 7 / 3 / 1 days left', () => {
    expect(shouldNotifyDaysLeft(7)).toBe(true)
    expect(shouldNotifyDaysLeft(3)).toBe(true)
    expect(shouldNotifyDaysLeft(1)).toBe(true)
  })

  test('silent on all other day counts (no spam)', () => {
    for (const d of [8, 6, 5, 4, 2, 0, -1]) {
      expect(shouldNotifyDaysLeft(d)).toBe(false)
    }
  })
})

describe('filterReminderOrgs — which orgs trigger today', () => {
  test('keeps only orgs whose whole-days-left is a threshold day', () => {
    const rows = [
      org(new Date(NOW.getTime() + 7 * DAY), { id: 'a' }), // keep
      org(new Date(NOW.getTime() + 6 * DAY), { id: 'b' }), // skip
      org(new Date(NOW.getTime() + 3 * DAY), { id: 'c' }), // keep
      org(new Date(NOW.getTime() + 1.2 * DAY), { id: 'd' }), // ceil→2, skip
      org(new Date(NOW.getTime() + 0.9 * DAY), { id: 'e' }), // ceil→1, keep
      org(null, { id: 'f' }), // no expiry — skip
      org(new Date(NOW.getTime() - DAY), { id: 'g' }), // already expired — skip
    ]
    const kept = filterReminderOrgs(rows, NOW)
    expect(kept.map((o) => o.id).sort()).toEqual(['a', 'c', 'e'])
  })

  test('empty input → empty output', () => {
    expect(filterReminderOrgs([], NOW)).toEqual([])
  })
})

describe('buildReminderMessage', () => {
  test('mentions org, timeframe, date and renewal path', () => {
    const msg = buildReminderMessage(org(new Date('2026-09-02T00:00:00.000Z')), NOW)
    expect(msg).toContain('"Acme" (acme)')
    expect(msg).toContain('in 7 days')
    expect(msg).toContain('2026-09-02')
    expect(msg).toContain('Settings')
    expect(msg).toContain('Plan: flat.')
  })

  test('singular phrasing for 1 day left', () => {
    const msg = buildReminderMessage(org(new Date('2026-08-27T06:00:00.000Z')), NOW)
    expect(msg).toContain('tomorrow')
  })
})

// ===========================================================================
// runLicenseExpiryReminders — the orchestration itself
// ===========================================================================

function resetState() {
  state.orgs = []
  mockSendCapture.length = 0
  state.cfg = { id: 'nc-1', encryptedConfig: 'enc' }
  state.updates = []
  state.updateRejects = false
  state.bypassCalls = 0
  state.notify = async () => ({ ok: true, latencyMs: 1 })
  mockOrgFindMany.mockClear()
  mockCfgFindFirst.mockClear()
  mockCfgUpdate.mockClear()
}

describe('runLicenseExpiryReminders — the expiry scan', () => {
  test('scans a 7-day horizon starting at `now`, for VALID licenses only', async () => {
    resetState()
    await runLicenseExpiryReminders(NOW)
    const where = (mockOrgFindMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where
    expect(where.licenseStatus).toBe('valid')
    // The window must START at now and END 7 days out, so an already-expired
    // license is not warned about (too late) and a far-off one is not warned
    // about (too early, would be spam).
    const win = where.licenseExpiresAt as { gte: Date; lte: Date }
    expect(win.gte.getTime()).toBe(NOW.getTime())
    expect(win.lte.getTime()).toBe(NOW.getTime() + 7 * DAY)
  })

  test('an org with NO configured channel is counted as skipped, not failed', async () => {
    // The distinction matters operationally: skippedNoChannel means "the customer
    // has not set up alerts" (expected), whereas failed means "we tried and the
    // channel broke" (needs an operator). Collapsing them would hide real outages.
    resetState()
    state.orgs = [org(new Date(NOW.getTime() + 3 * DAY))]
    state.cfg = null
    const summary = await runLicenseExpiryReminders(NOW)
    expect(summary).toEqual({ checked: 1, notified: 0, skippedNoChannel: 1, failed: 0 })
  })

  test('a successful send is counted, and lastUsedAt is refreshed', async () => {
    resetState()
    state.orgs = [org(new Date(NOW.getTime() + 3 * DAY))]
    const summary = await runLicenseExpiryReminders(NOW)
    expect(summary).toEqual({ checked: 1, notified: 1, skippedNoChannel: 0, failed: 0 })
    // The most-recently-used channel ordering depends on this write.
    expect(state.updates.length).toBe(1)
    expect((state.updates[0] as { where: { id: string } }).where.id).toBe('nc-1')
  })

  test('a FAILED send is counted as failed and does NOT refresh lastUsedAt', async () => {
    resetState()
    state.orgs = [org(new Date(NOW.getTime() + 3 * DAY))]
    state.notify = async () => ({ ok: false, error: 'webhook 500' })
    const summary = await runLicenseExpiryReminders(NOW)
    expect(summary).toEqual({ checked: 1, notified: 0, skippedNoChannel: 0, failed: 1 })
    // A failed delivery must not look "used", or the channel ordering would be
    // skewed by attempts that never reached anyone.
    expect(state.updates.length).toBe(0)
  })

  test('an org NOT at a threshold day is not notified at all', async () => {
    resetState()
    // 5 days left: inside the 7-day scan window but not a 7/3/1 threshold day.
    state.orgs = [org(new Date(NOW.getTime() + 5 * DAY))]
    const summary = await runLicenseExpiryReminders(NOW)
    expect(summary).toEqual({ checked: 1, notified: 0, skippedNoChannel: 0, failed: 0 })
    // It never even looked up a channel for it.
    expect(mockCfgFindFirst).not.toHaveBeenCalled()
  })

  test('the send receives the resolved channel config, the org message and a stable title', async () => {
    // A test that only asserted "findFirst was called" proved nothing about what
    // was DELIVERED. The mock now captures the argument so the payload itself is
    // checked: the wrong config would send to the wrong channel, and the wrong
    // message would tell a customer nothing actionable.
    resetState()
    state.orgs = [org(new Date(NOW.getTime() + 1 * DAY))]
    const sent: Array<{ configEncrypted?: string; message?: string; title?: string }> = []
    mockSendCapture.length = 0
    mockSendCapture.push((a) => sent.push(a as never))
    const summary = await runLicenseExpiryReminders(NOW)
    expect(summary.notified).toBe(1)
    expect(sent.length).toBe(1)
    expect(sent[0].configEncrypted).toBe('enc')
    expect(sent[0].title).toBe('Subscription expiring soon')
    // buildReminderMessage is the single source of the wording; assert the real
    // one is used rather than a duplicated string.
    expect(sent[0].message).toBe(buildReminderMessage(org(new Date(NOW.getTime() + 1 * DAY)), NOW))
  })

  test('a rejecting lastUsedAt write does NOT fail the run', async () => {
    // The write is fire-and-forget with logSwallowed. A notification that was
    // DELIVERED must still count as delivered even if the bookkeeping write fails --
    // otherwise a transient DB blip would retry the whole day's notifications.
    resetState()
    state.orgs = [org(new Date(NOW.getTime() + 3 * DAY))]
    mockCfgUpdate.mockImplementation(async () => { throw new Error('db gone') })
    const summary = await runLicenseExpiryReminders(NOW)
    expect(summary.notified).toBe(1)
    expect(summary.failed).toBe(0)
  })

  test('the scan runs OUTSIDE a request context (bypassOrg), once per org lookup', async () => {
    // The job runs in a worker with no org context, so bypassOrg is what lets it
    // read across tenants at all. Counting the calls pins that the per-org channel
    // lookup is also wrapped -- a bare read there would resolve the wrong tenant
    // or nothing.
    resetState()
    state.orgs = [org(new Date(NOW.getTime() + 3 * DAY))]
    await runLicenseExpiryReminders(NOW)
    // one for the org scan + one for the channel lookup
    expect(state.bypassCalls).toBe(2)
  })

  test('multiple orgs are processed independently', async () => {
    resetState()
    state.orgs = [
      org(new Date(NOW.getTime() + 7 * DAY), { id: 'a', slug: 'a' }),
      org(new Date(NOW.getTime() + 3 * DAY), { id: 'b', slug: 'b' }),
      org(new Date(NOW.getTime() + 5 * DAY), { id: 'c', slug: 'c' }), // not a threshold
    ]
    let call = 0
    mockCfgFindFirst.mockImplementation(async () => (++call === 2 ? null : { id: `nc-${call}`, encryptedConfig: 'enc' }))
    const summary = await runLicenseExpiryReminders(NOW)
    // checked counts everything in the window; only the two threshold orgs proceed.
    expect(summary.checked).toBe(3)
    expect(summary.notified + summary.skippedNoChannel).toBe(2)
    expect(summary.failed).toBe(0)
  })
})
