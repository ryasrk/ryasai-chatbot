import { describe, expect, test } from 'bun:test'
import {
  hasPlan,
  PLAN_FEATURES,
  checkQuota,
  quotaExceededMessage,
  quotaFor,
  type Plan,
} from './plan-gating'

describe('hasPlan — rank ordering', () => {
  test('flat ranks above enterprise', () => {
    expect(hasPlan('flat', 'enterprise')).toBe(true)
    expect(hasPlan('flat', 'flat')).toBe(true)
  })

  test('enterprise does NOT satisfy flat', () => {
    expect(hasPlan('enterprise', 'flat')).toBe(false)
  })

  test('legacy plans keep working', () => {
    expect(hasPlan('starter', 'pro')).toBe(false)
    expect(hasPlan('pro', 'starter')).toBe(true)
    expect(hasPlan('pro', 'pro')).toBe(true)
    expect(hasPlan('pro', 'enterprise')).toBe(false)
  })

  test('null/undefined plan treated as starter', () => {
    expect(hasPlan(null, 'starter')).toBe(true)
    expect(hasPlan(undefined, 'pro')).toBe(false)
  })
})

describe('PLAN_FEATURES', () => {
  const ALL_KEYS: Array<keyof (typeof PLAN_FEATURES)['flat']> = [
    'maxUsers',
    'maxIntegrations',
    'maxDocuments',
    'mcp',
    'schedules',
    'agent',
    'sso',
  ]

  test("every plan has an entry (Record<Plan,…> is exhaustive at compile time, verify at runtime too)", () => {
    const plans: Plan[] = ['starter', 'pro', 'enterprise', 'flat']
    for (const p of plans) {
      for (const k of ALL_KEYS) {
        expect(PLAN_FEATURES[p][k]).toBeDefined()
      }
    }
  })

  test('flat matches enterprise limits and unlocks all features', () => {
    expect(PLAN_FEATURES.flat).toEqual(PLAN_FEATURES.enterprise)
    expect(PLAN_FEATURES.flat.mcp).toBe(true)
    expect(PLAN_FEATURES.flat.schedules).toBe(true)
    expect(PLAN_FEATURES.flat.agent).toBe(true)
    expect(PLAN_FEATURES.flat.sso).toBe(true)
  })
})

describe('quotaFor — fail-closed plan resolution', () => {
  test('an unknown plan resolves to the LOWEST tier, not the highest', () => {
    // This is the load-bearing direction. Falling back to `flat` would mean a
    // typo'd or missing plan silently unlocks the biggest quotas.
    expect(quotaFor('garbage')).toEqual(PLAN_FEATURES.starter)
    expect(quotaFor(null)).toEqual(PLAN_FEATURES.starter)
    expect(quotaFor(undefined)).toEqual(PLAN_FEATURES.starter)
    expect(quotaFor('')).toEqual(PLAN_FEATURES.starter)
  })

  test('a known plan resolves to its own row', () => {
    expect(quotaFor('pro')).toEqual(PLAN_FEATURES.pro)
    expect(quotaFor('flat')).toEqual(PLAN_FEATURES.flat)
  })
})

describe('checkQuota — boundary behaviour', () => {
  test('allows the create that exactly fills the quota', () => {
    // starter.maxIntegrations = 1. Going 0 -> 1 must pass.
    expect(checkQuota('starter', 'maxIntegrations', 0).allowed).toBe(true)
  })

  test('refuses the create that would exceed it', () => {
    // starter.maxIntegrations = 1. Going 1 -> 2 must fail.
    const d = checkQuota('starter', 'maxIntegrations', 1)
    expect(d.allowed).toBe(false)
    expect(d.limit).toBe(1)
    expect(d.current).toBe(1)
  })

  test('an unknown plan is capped like starter (end-to-end fail-closed)', () => {
    expect(checkQuota('nonsense-plan', 'maxIntegrations', 1).allowed).toBe(false)
    expect(checkQuota(null, 'maxDocuments', 25).allowed).toBe(false)
  })

  test('higher plans permit more — each tier is genuinely distinct', () => {
    expect(checkQuota('starter', 'maxIntegrations', 1).allowed).toBe(false)
    expect(checkQuota('pro', 'maxIntegrations', 1).allowed).toBe(true)
    expect(checkQuota('pro', 'maxIntegrations', 5).allowed).toBe(false)
    expect(checkQuota('flat', 'maxIntegrations', 50).allowed).toBe(false)
    expect(checkQuota('flat', 'maxIntegrations', 49).allowed).toBe(true)
  })

  test('requested > 1 is respected (bulk add)', () => {
    // pro.maxDocuments = 250; 240 + 10 = 250 fits, 241 + 10 = 251 does not.
    expect(checkQuota('pro', 'maxDocuments', 240, 10).allowed).toBe(true)
    expect(checkQuota('pro', 'maxDocuments', 241, 10).allowed).toBe(false)
  })

  test('a non-positive limit means unlimited', () => {
    const original = PLAN_FEATURES.enterprise.maxUsers
    try {
      ;(PLAN_FEATURES.enterprise as { maxUsers: number }).maxUsers = 0
      const d = checkQuota('enterprise', 'maxUsers', 999_999)
      expect(d.allowed).toBe(true)
      expect(d.limit).toBeNull()
    } finally {
      ;(PLAN_FEATURES.enterprise as { maxUsers: number }).maxUsers = original
    }
  })

  test('every plan × every quota key is decidable without throwing', () => {
    const plans: Plan[] = ['starter', 'pro', 'enterprise', 'flat']
    const keys = ['maxUsers', 'maxIntegrations', 'maxDocuments'] as const
    for (const p of plans) {
      for (const k of keys) {
        const d = checkQuota(p, k, 0)
        expect(typeof d.allowed).toBe('boolean')
        expect(d.limit).toBe(PLAN_FEATURES[p][k])
      }
    }
  })
})

describe('quotaExceededMessage — operator-facing text', () => {
  test('names the specific resource and states the ceiling', () => {
    const d = checkQuota('starter', 'maxIntegrations', 1)
    const msg = quotaExceededMessage('maxIntegrations', d)
    expect(msg).toContain('data sources')
    expect(msg).toContain('1')
    expect(msg).toMatch(/upgrade/i)
  })

  test('uses a distinct noun per quota (not one generic word)', () => {
    const d = checkQuota('starter', 'maxUsers', 3)
    expect(quotaExceededMessage('maxUsers', d)).toContain('users')
    expect(quotaExceededMessage('maxDocuments', d)).toContain('documents')
    expect(quotaExceededMessage('maxIntegrations', d)).toContain('data sources')
  })

  test('does not tell an over-quota org its limit is null', () => {
    const d = checkQuota('starter', 'maxUsers', 3)
    expect(quotaExceededMessage('maxUsers', d)).not.toContain('null')
  })
})
