import { describe, expect, test, beforeEach } from 'bun:test'
import { getPacks, findPack } from './pricing'

const original = process.env.BILLING_PACKS_JSON

beforeEach(() => {
  process.env.BILLING_PACKS_JSON = original
})

describe('getPacks', () => {
  test('defaults to the standard pack table', () => {
    delete process.env.BILLING_PACKS_JSON
    expect(getPacks()).toEqual([
      { months: 1, amountIdr: 100_000 },
      { months: 3, amountIdr: 270_000 },
      { months: 6, amountIdr: 480_000 },
      { months: 12, amountIdr: 840_000 },
    ])
  })

  test('BILLING_PACKS_JSON overrides amounts', () => {
    process.env.BILLING_PACKS_JSON =
      '[{"months":1,"amountIdr":150000},{"months":12,"amountIdr":900000}]'
    expect(getPacks()).toEqual([
      { months: 1, amountIdr: 150_000 },
      { months: 12, amountIdr: 900_000 },
    ])
  })

  test('override packs are sorted by months', () => {
    process.env.BILLING_PACKS_JSON =
      '[{"months":6,"amountIdr":480000},{"months":1,"amountIdr":100000}]'
    expect(getPacks().map((p) => p.months)).toEqual([1, 6])
  })

  test('invalid JSON throws (fail closed)', () => {
    process.env.BILLING_PACKS_JSON = '{not-json'
    expect(() => getPacks()).toThrow(/BILLING_PACKS_JSON/)
  })

  test('non-array or empty array throws', () => {
    process.env.BILLING_PACKS_JSON = '{"months":1}'
    expect(() => getPacks()).toThrow(/BILLING_PACKS_JSON/)
    process.env.BILLING_PACKS_JSON = '[]'
    expect(() => getPacks()).toThrow(/BILLING_PACKS_JSON/)
  })

  test('bad entry shape throws', () => {
    process.env.BILLING_PACKS_JSON = '[{"months":0,"amountIdr":100}]'
    expect(() => getPacks()).toThrow(/positive integer/)
    process.env.BILLING_PACKS_JSON = '[{"months":3,"amountIdr":-5}]'
    expect(() => getPacks()).toThrow(/positive integer/)
    process.env.BILLING_PACKS_JSON = '[{"months":1.5,"amountIdr":100}]'
    expect(() => getPacks()).toThrow(/positive integer/)
  })

  test('duplicate month counts throw', () => {
    process.env.BILLING_PACKS_JSON =
      '[{"months":1,"amountIdr":100},{"months":1,"amountIdr":200}]'
    expect(() => getPacks()).toThrow(/duplicate/)
  })
})

describe('findPack', () => {
  beforeEach(() => {
    delete process.env.BILLING_PACKS_JSON
  })

  test('finds a pack by months', () => {
    expect(findPack(3)).toEqual({ months: 3, amountIdr: 270_000 })
  })

  test('returns undefined for unknown months', () => {
    expect(findPack(2)).toBeUndefined()
    expect(findPack(Number.NaN)).toBeUndefined()
  })
})
