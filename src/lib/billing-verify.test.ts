import { describe, expect, test } from 'bun:test'
import {
  parseGrossAmount,
  grossAmountMatchesIdr,
  safeSecretCompare,
} from './billing-verify'

describe('parseGrossAmount', () => {
  test('parses Midtrans decimal strings', () => {
    expect(parseGrossAmount('100000.00')).toBe(100000)
    expect(parseGrossAmount('270000.00')).toBe(270000)
    expect(parseGrossAmount('840000')).toBe(840000)
    expect(parseGrossAmount(' 1000.50 ')).toBe(1000.5)
  })

  test('accepts numbers as-is', () => {
    expect(parseGrossAmount(100000)).toBe(100000)
    expect(parseGrossAmount(0)).toBe(0)
  })

  test('rejects garbage without throwing', () => {
    expect(parseGrossAmount(undefined)).toBeNull()
    expect(parseGrossAmount(null)).toBeNull()
    expect(parseGrossAmount('')).toBeNull()
    expect(parseGrossAmount('abc')).toBeNull()
    expect(parseGrossAmount('1e999')).toBeNull() // Infinity → not finite
    expect(parseGrossAmount(NaN)).toBeNull()
    expect(parseGrossAmount({})).toBeNull()
  })
})

describe('grossAmountMatchesIdr', () => {
  test('exact match on the charged amount', () => {
    expect(grossAmountMatchesIdr('270000.00', 270000)).toBe(true)
    expect(grossAmountMatchesIdr(270000, 270000)).toBe(true)
  })

  test('float noise within tolerance passes, real mismatches fail', () => {
    expect(grossAmountMatchesIdr('269999.995', 270000)).toBe(true)
    expect(grossAmountMatchesIdr('100000.00', 270000)).toBe(false)
    expect(grossAmountMatchesIdr('269901.00', 270000)).toBe(false)
  })

  test('unparseable amount never matches (fail closed)', () => {
    expect(grossAmountMatchesIdr(undefined, 270000)).toBe(false)
    expect(grossAmountMatchesIdr('garbage', 270000)).toBe(false)
  })
})

describe('safeSecretCompare', () => {
  const SECRET = 'whsec_abcdef123456'

  test('accepts equal secrets', () => {
    expect(safeSecretCompare(SECRET, SECRET)).toBe(true)
  })

  test('rejects wrong secrets of equal length', () => {
    expect(safeSecretCompare('whsec_abcdef123457', SECRET)).toBe(false)
  })

  test('rejects length mismatches without throwing', () => {
    expect(safeSecretCompare('short', SECRET)).toBe(false)
    expect(safeSecretCompare(SECRET, 'a-much-longer-value-than-the-secret')).toBe(false)
  })

  test('rejects missing values (fail closed)', () => {
    expect(safeSecretCompare(null, SECRET)).toBe(false)
    expect(safeSecretCompare(SECRET, undefined)).toBe(false)
    expect(safeSecretCompare('', '')).toBe(false)
  })
})
