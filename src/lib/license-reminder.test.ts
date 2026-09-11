import { describe, expect, test, mock } from 'bun:test'

// ponytail: each *.test.ts runs in its own bun subprocess (mock.module leaks
// across files in one process). Mock the DB/tenant/notification deps so this
// test only exercises the pure eligibility logic + message building.
mock.module('./db', () => ({ db: {} }))
mock.module('./prisma-tenant', () => ({
  bypassOrg: async <T>(fn: () => T) => fn(),
  enterWithOrg: () => {},
}))
mock.module('./notifications', () => ({
  sendNotificationWithRetry: async () => ({ ok: true, latencyMs: 1 }),
}))

const { shouldNotifyDaysLeft, filterReminderOrgs, buildReminderMessage } = await import('./license-reminder')

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
