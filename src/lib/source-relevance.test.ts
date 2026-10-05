import { describe, expect, test } from 'bun:test'
import { rankByRelevance, relevanceScore, relevanceTokens, selectRelevant } from '@/lib/source-relevance'

// MEASURED with a recorder model, six databases and three REST APIs: the answering table (`leave_balances`, one of
// 40) and the answering endpoint (`/ship/track`, past the 40th position) were never shown to the model. These
// cases pin the ranking that now decides what is shown.

describe('relevanceTokens', () => {
  test('splits snake_case, camelCase and punctuation, lowercases, drops short words', () => {
    expect(relevanceTokens('leave_balances')).toEqual(['leave', 'balance'])
    expect(relevanceTokens('shipmentEvents')).toEqual(['shipment', 'event'])
    expect(relevanceTokens('GET /ship/track?id=1')).toEqual(['get', 'ship', 'track'])
  })

  test('singularises plurals so "shipments" meets "shipment" and "balances" meets "balance"', () => {
    expect(relevanceTokens('shipments')).toEqual(relevanceTokens('shipment'))
    expect(relevanceTokens('balances')).toEqual(relevanceTokens('balance'))
    expect(relevanceTokens('categories boxes statuses address')).toEqual(['category', 'box', 'status', 'address'])
  })

  test('keeps non-Latin and Indonesian words (no ASCII-only split)', () => {
    expect(relevanceTokens('berapa sisa cuti karyawan?')).toEqual(['berapa', 'sisa', 'cuti', 'karyawan'])
  })
})

describe('relevanceScore', () => {
  test('counts shared stems, including a prefix of 4+ characters either way', () => {
    const q = new Set(relevanceTokens('track my shipment'))
    expect(relevanceScore('/ship/track — Track a shipment', q)).toBe(3) // ship~shipment, track, shipment
    expect(relevanceScore('/weather/feed', q)).toBe(0)
  })
})

describe('rankByRelevance', () => {
  const tables = ['accounts', 'departments', 'employees', 'hr_aux_00', 'hr_aux_01', 'leave_balances', 'payroll_runs']

  test('the answering table comes first, ahead of alphabetically earlier ones', () => {
    expect(rankByRelevance(tables, (t) => t, ['How many leave days does employee 7 have left?']).slice(0, 2))
      .toEqual(['employees', 'leave_balances'])
  })

  test('a translated phrasing counts: "sisa cuti" reaches leave_balances through "leave"', () => {
    const ranked = rankByRelevance(tables, (t) => t, ['Berapa sisa cuti karyawan 7?', 'berapa sisa leave employee 7?'])
    expect(ranked.slice(0, 2)).toContain('leave_balances')
  })

  test('with nothing relevant the input order is kept (stable)', () => {
    expect(rankByRelevance(tables, (t) => t, ['halo apa kabar'])).toEqual(tables)
    expect(rankByRelevance(tables, (t) => t, [])).toEqual(tables)
  })
})

describe('selectRelevant', () => {
  type E = { id: string; group: string; text: string }
  const make = (group: string, n: number, text = (i: number) => `${group} feed ${i}`): E[] =>
    Array.from({ length: n }, (_, i) => ({ id: `${group}${i}`, group, text: text(i) }))

  test('a relevant item past the limit by POSITION still makes the cut', () => {
    const items = [...make('crm', 20), ...make('weather', 15), ...make('ship', 14), { id: 'track', group: 'ship', text: '/ship/track Track a shipment' }]
    const picked = selectRelevant(items, (e) => e.text, (e) => e.group, ['Track shipment SHP-1001'], 40)
    expect(picked).toHaveLength(40)
    expect(picked[0].id).toBe('track')
  })

  test('with nothing relevant every group keeps a share instead of the first group filling every slot', () => {
    const items = [...make('big', 45), ...make('small', 5)]
    const picked = selectRelevant(items, (e) => e.text, (e) => e.group, ['q'], 40)
    expect(picked).toHaveLength(40)
    expect(picked.filter((e) => e.group === 'small')).toHaveLength(5)
  })

  test('fewer items than the limit returns them all', () => {
    expect(selectRelevant(make('a', 3), (e) => e.text, (e) => e.group, ['x'], 40)).toHaveLength(3)
  })
})
