import { describe, expect, test } from 'bun:test'
import { parseCron, nextRun } from './cron'

describe('parseCron', () => {
  test('0 9 * * * matches 09:00 on any day, not 09:01', () => {
    const c = parseCron('0 9 * * *')!
    expect(c).not.toBeNull()
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 9, 0, 0)))).toBe(true)
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 9, 1, 0)))).toBe(false)
  })

  test('*/15 * * * * matches :00 :15 :30 :45', () => {
    const c = parseCron('*/15 * * * *')!
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 10, 0, 0)))).toBe(true)
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 10, 15, 0)))).toBe(true)
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 10, 30, 0)))).toBe(true)
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 10, 45, 0)))).toBe(true)
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 10, 7, 0)))).toBe(false)
  })

  test('0 9 * * 1-5 matches 09:00 Mon-Fri, not Sat/Sun', () => {
    const c = parseCron('0 9 * * 1-5')!
    // 2026-07-24 is Friday
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 9, 0, 0)))).toBe(true)
    // 2026-07-25 is Saturday
    expect(c.match(new Date(Date.UTC(2026, 6, 25, 9, 0, 0)))).toBe(false)
    // 2026-07-26 is Sunday
    expect(c.match(new Date(Date.UTC(2026, 6, 26, 9, 0, 0)))).toBe(false)
  })

  test('invalid expression returns null', () => {
    expect(parseCron('invalid')).toBeNull()
  })

  test('wrong number of fields returns null', () => {
    expect(parseCron('too many fields here')).toBeNull()
  })

  test('out-of-range values return null', () => {
    expect(parseCron('60 9 * * *')).toBeNull()
    expect(parseCron('0 25 * * *')).toBeNull()
    expect(parseCron('0 9 32 * *')).toBeNull()
  })

  test('step values work', () => {
    const c = parseCron('1-10/2 * * * *')!
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 10, 1, 0)))).toBe(true)
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 10, 3, 0)))).toBe(true)
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 10, 2, 0)))).toBe(false)
  })

  test('DOW 7 normalises to Sunday (0)', () => {
    const c = parseCron('0 9 * * 7')!
    // 2026-07-26 is Sunday — getUTCDay() === 0
    expect(c.match(new Date(Date.UTC(2026, 6, 26, 9, 0, 0)))).toBe(true)
    expect(c.match(new Date(Date.UTC(2026, 6, 24, 9, 0, 0)))).toBe(false) // Friday
  })
})

describe('nextRun', () => {
  test('0 9 * * * from 10:00 → next day 09:00', () => {
    const result = nextRun('0 9 * * *', new Date('2026-07-24T10:00:00Z'))
    expect(result).toEqual(new Date('2026-07-25T09:00:00Z'))
  })

  test('*/15 * * * * from 10:05 → 10:15', () => {
    const result = nextRun('*/15 * * * *', new Date('2026-07-24T10:05:00Z'))
    expect(result).toEqual(new Date('2026-07-24T10:15:00Z'))
  })

  test('invalid expression returns null', () => {
    expect(nextRun('invalid', new Date())).toBeNull()
  })

  test('returns strictly after from, not the current minute', () => {
    // from is exactly 10:00:00 — cron matches :00, but we want the NEXT match
    const result = nextRun('*/15 * * * *', new Date('2026-07-24T10:00:00Z'))
    expect(result).toEqual(new Date('2026-07-24T10:15:00Z'))
  })
})
