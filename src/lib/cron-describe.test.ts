import { describe, expect, test } from 'bun:test'
import { describeCron, formatRelativeTime, previewNextRuns } from './cron-describe'

describe('describeCron', () => {
  test('describes every minute', () => {
    expect(describeCron('* * * * *')).toBe('Every minute')
  })
  test('describes every 5 minutes', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes')
  })
  test('describes daily at 9am', () => {
    expect(describeCron('0 9 * * *')).toBe('Every day at 09:00')
  })
  test('describes weekdays', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays (Mon-Fri) at 09:00')
  })
  test('describes weekly Monday', () => {
    expect(describeCron('0 9 * * 1')).toBe('Every Monday at 09:00')
  })
  test('describes monthly', () => {
    expect(describeCron('0 0 1 * *')).toBe('On day 1 at 00:00')
  })
  test('describes every hour', () => {
    expect(describeCron('0 * * * *')).toBe('Every hour at minute 0')
  })
  test('returns error for invalid', () => {
    expect(describeCron('invalid')).toBe('Invalid cron expression')
  })
})

describe('formatRelativeTime', () => {
  test('shows future minutes', () => {
    const now = new Date('2026-01-01T10:00:00Z')
    const future = new Date('2026-01-01T10:15:00Z').toISOString()
    expect(formatRelativeTime(future, now)).toBe('in 15 minutes')
  })
  test('shows past hours', () => {
    const now = new Date('2026-01-01T10:00:00Z')
    const past = new Date('2026-01-01T07:00:00Z').toISOString()
    expect(formatRelativeTime(past, now)).toBe('3 hours ago')
  })
  test('shows dash for null', () => {
    expect(formatRelativeTime(null)).toBe('-')
  })
})

describe('previewNextRuns', () => {
  test('previews next 5 runs for daily cron', () => {
    const from = new Date('2026-01-01T08:00:00Z')
    const runs = previewNextRuns('0 9 * * *', from, 5)
    expect(runs.length).toBe(5)
    expect(runs[0].getUTCHours()).toBe(9)
  })
  test('returns empty for invalid cron', () => {
    expect(previewNextRuns('invalid')).toEqual([])
  })
})
