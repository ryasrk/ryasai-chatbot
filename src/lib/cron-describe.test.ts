import { describe, expect, test } from 'bun:test'
import { describeCron, formatRelativeTime, previewNextRuns, SCHEDULE_PRESETS } from './cron-describe'

describe('describeCron', () => {
  test('describes every minute', () => {
    expect(describeCron('* * * * *')).toBe('Every minute')
  })
  test('describes every 5 minutes', () => {
    expect(describeCron('*/5 * * * *')).toBe('Every 5 minutes')
  })
  test('describes every 15 minutes', () => {
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes')
  })
  test('describes every hour at minute 0', () => {
    expect(describeCron('0 * * * *')).toBe('Every hour at minute 0')
  })
  test('describes every hour at minute 30', () => {
    expect(describeCron('30 * * * *')).toBe('Every hour at minute 30')
  })
  test('describes every 6 hours', () => {
    expect(describeCron('0 */6 * * *')).toBe('Every 6 hours')
  })
  test('describes daily at 9am', () => {
    expect(describeCron('0 9 * * *')).toBe('Every day at 09:00')
  })
  test('describes daily at 18:00', () => {
    expect(describeCron('0 18 * * *')).toBe('Every day at 18:00')
  })
  test('describes weekdays Mon-Fri at 09:00', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays (Mon-Fri) at 09:00')
  })
  test('describes weekends Sat-Sun at 10:00', () => {
    expect(describeCron('0 10 * * 6,0')).toBe('Weekends (Sat-Sun) at 10:00')
  })
  test('describes weekends with 0,6 ordering', () => {
    expect(describeCron('0 10 * * 0,6')).toBe('Weekends (Sat-Sun) at 10:00')
  })
  test('describes weekly Monday', () => {
    expect(describeCron('0 9 * * 1')).toBe('Every Monday at 09:00')
  })
  test('describes every Saturday', () => {
    expect(describeCron('0 10 * * 6')).toBe('Every Saturday at 10:00')
  })
  test('describes two days with "and"', () => {
    expect(describeCron('0 9 * * 1,3')).toBe('Every Monday and Wednesday at 09:00')
  })
  test('describes day range Mon-Wed', () => {
    expect(describeCron('0 9 * * 1-3')).toBe('Every Monday, Tuesday, Wednesday at 09:00')
  })
  test('describes monthly on day 1', () => {
    expect(describeCron('0 0 1 * *')).toBe('On day 1 at 00:00')
  })
  test('describes monthly on day 15 at noon', () => {
    expect(describeCron('0 12 15 * *')).toBe('On day 15 at 12:00')
  })
  test('describes Sunday night midnight', () => {
    expect(describeCron('0 0 * * 0')).toBe('Every Sunday at 00:00')
  })
  test('returns error for invalid', () => {
    expect(describeCron('invalid')).toBe('Invalid cron expression')
  })
  test('returns error for wrong field count', () => {
    expect(describeCron('0 9 * *')).toBe('Invalid cron expression')
  })
  test('SCHEDULE_PRESETS all have valid descriptions', () => {
    for (const preset of SCHEDULE_PRESETS) {
      expect(describeCron(preset.expr)).not.toBe('Invalid cron expression')
    }
  })
})

describe('formatRelativeTime', () => {
  const NOW = new Date('2026-01-01T10:00:00Z')

  test('shows "now" for sub-minute difference', () => {
    const near = new Date('2026-01-01T10:00:10Z').toISOString()
    expect(formatRelativeTime(near, NOW)).toBe('now')
  })

  test('shows future minutes', () => {
    const future = new Date('2026-01-01T10:15:00Z').toISOString()
    expect(formatRelativeTime(future, NOW)).toBe('in 15 minutes')
  })

  test('shows past minutes', () => {
    const past = new Date('2026-01-01T09:45:00Z').toISOString()
    expect(formatRelativeTime(past, NOW)).toBe('15 minutes ago')
  })

  test('shows past hours', () => {
    const past = new Date('2026-01-01T07:00:00Z').toISOString()
    expect(formatRelativeTime(past, NOW)).toBe('3 hours ago')
  })

  test('shows future hours', () => {
    const future = new Date('2026-01-01T13:00:00Z').toISOString()
    expect(formatRelativeTime(future, NOW)).toBe('in 3 hours')
  })

  test('shows past days', () => {
    const past = new Date('2025-12-29T10:00:00Z').toISOString()
    expect(formatRelativeTime(past, NOW)).toBe('3 days ago')
  })

  test('shows future days', () => {
    const future = new Date('2026-01-04T10:00:00Z').toISOString()
    expect(formatRelativeTime(future, NOW)).toBe('in 3 days')
  })

  test('shows formatted date for >= 7 days', () => {
    const past = new Date('2025-12-20T10:00:00Z').toISOString()
    const result = formatRelativeTime(past, NOW)
    expect(result).toMatch(/Dec/)
    expect(result).toMatch(/2025/)
  })

  test('shows dash for null', () => {
    expect(formatRelativeTime(null)).toBe('-')
  })

  test('shows dash for empty string', () => {
    expect(formatRelativeTime('')).toBe('-')
  })
})

describe('previewNextRuns', () => {
  test('previews next 5 runs for daily cron', () => {
    const from = new Date('2026-01-01T08:00:00Z')
    const runs = previewNextRuns('0 9 * * *', from, 5)
    expect(runs.length).toBe(5)
    expect(runs[0].getUTCHours()).toBe(9)
  })

  test('previews sequential runs (each after the previous)', () => {
    const from = new Date('2026-01-01T08:00:00Z')
    const runs = previewNextRuns('0 9 * * *', from, 3)
    expect(runs[1].getTime()).toBeGreaterThan(runs[0].getTime())
    expect(runs[2].getTime()).toBeGreaterThan(runs[1].getTime())
  })

  test('default count is 5', () => {
    const from = new Date('2026-01-01T08:00:00Z')
    const runs = previewNextRuns('0 9 * * *', from)
    expect(runs.length).toBe(5)
  })

  test('returns empty for invalid cron', () => {
    expect(previewNextRuns('invalid')).toEqual([])
  })

  test('previews every-minute cron', () => {
    const from = new Date('2026-01-01T10:00:00Z')
    const runs = previewNextRuns('* * * * *', from, 3)
    expect(runs.length).toBe(3)
    expect(runs[0].getUTCMinutes()).toBe(1)
  })
})
