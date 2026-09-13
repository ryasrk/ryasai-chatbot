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

// ===========================================================================
// The fall-through composition path: buildTimeDesc + buildDateDesc
// ===========================================================================
//
// describeCron has a chain of specific early returns, so an expression that
// outruns them all reaches lines 53-55 and the two composers. Those composers
// also carry their OWN branches (a step in the HOUR field, a day RANGE, a month
// list), none of which any existing test ran.

describe('describeCron — composed time and date descriptions', () => {
  // Outputs below are MEASURED, not assumed. My first draft wrote them with a comma
  // after "minutes" ("Every 10 minutes, every Monday"); the real text has no comma
  // because the two composers are joined with a single space. Seven of nine
  // assertions went red and the dump corrected every one of them.

  test('a MINUTE step combined with a day-of-week uses both composers', () => {
    // `*/10 * * * 1` : the minute-step early return needs dowField === '*', so this
    // falls through to buildTimeDesc + buildDateDesc.
    expect(describeCron('*/10 * * * 1')).toBe('Every 10 minutes every Monday')
  })

  test('an HOUR step with minute 0 is described in HOURS by buildTimeDesc', () => {
    // The early `Every N hours` return requires every other field to be '*'; with a
    // day-of-week set it is buildTimeDesc that recognises the step.
    expect(describeCron('0 */3 * * 5')).toBe('Every 3 hours every Friday')
  })

  test('a single minute with an HOUR step is NOT described as an hour count', () => {
    // The `hourStep && minField === '0'` guard. With minField = 30 the step must be
    // ignored and the raw fallback used, otherwise the description would claim the
    // job runs every 3 hours when it actually runs at :30.
    const out = describeCron('30 */3 * * 5')
    expect(out).not.toContain('Every 3 hours')
    expect(out).toBe('Minute: 30, Hour: */3 every Friday')
  })

  test('an unworded minute and hour fall back to the RAW fields', () => {
    // A value the describer has no wording for still shows something readable rather
    // than an empty string.
    expect(describeCron('5,10 9 * * 3')).toBe('Minute: 5,10, Hour: 9 every Wednesday')
  })

  test('a day-of-week LIST of three or more is joined with commas', () => {
    // Two days use "X and Y"; three or more use the comma join, and that third path
    // is only reached by a longer list.
    expect(describeCron('*/10 * * * 1,3,5'))
      .toBe('Every 10 minutes every Monday, Wednesday, Friday')
  })

  test('a day RANGE spanning the week works in the composed path', () => {
    // parseDayList expands a range; reached here through buildDateDesc rather than
    // the dedicated weekday branch (which only matches the literal '1-5').
    expect(describeCron('*/10 * * * 2-4'))
      .toBe('Every 10 minutes every Tuesday, Wednesday, Thursday')
  })

  test('a MONTH list is named', () => {
    expect(describeCron('*/10 * * 1,6 *')).toContain('month January, June')
  })

  test('an OUT-OF-RANGE month is REJECTED by parseCron, not rendered as a number', () => {
    // Pinned as MEASURED. I expected the month branch's `months[n-1] || n` fallback
    // to print "month 13"; parseCron rejects 13 first, so the describer never runs.
    // The `|| n` fallback is therefore only reachable for a value parseCron accepts
    // but the month-name array does not cover -- i.e. it is effectively dead for
    // months, and this records that rather than inventing a case for it.
    expect(describeCron('*/10 * * 13 *')).toBe('Invalid cron expression')
  })

  test('day-of-month AND month are BOTH described', () => {
    // This was a MEASURED BUG, previously pinned as behaviour: buildDateDesc guarded the
    // day-of-month fragment with `monthField === '*'`, so the two were mutually exclusive
    // and `*/10 * 15 3 *` described itself as "Every 10 minutes month March" -- IDENTICAL
    // to `*/10 * * 3 *`, which runs every day in March. A user reading the description
    // would pick the wrong day.
    //
    // Fixed by removing the month guard. That is a CORRECTNESS fix, not a rewording: it
    // only adds a missing fragment, and every case that already rendered correctly is
    // unchanged (the full suite verifies that).
    expect(describeCron('*/10 * 15 3 *')).toBe('Every 10 minutes day 15, month March')
    expect(describeCron('*/10 * 15 3 *')).toContain('day 15')
    // The two expressions must now be DISTINGUISHABLE -- that is the whole point.
    expect(describeCron('*/10 * 15 3 *')).not.toBe(describeCron('*/10 * * 3 *'))
    expect(describeCron('*/10 * * 3 *')).toBe('Every 10 minutes month March')
  })

  test('the single-hour branch also keeps its day when a month is set', () => {
    // The same bug reached a DIFFERENT early-return: `0 9 15 3 *` returned
    // "At 09:00 month March", dropping the 15 just like the step case above.
    expect(describeCron('0 9 15 3 *')).toBe('At 09:00 day 15, month March')
  })

  test('a schedule with NOTHING extra is described as "every day"', () => {
    // buildDateDesc's `parts.length > 0 ? ... : 'every day'` fallback.
    expect(describeCron('*/10 8 * * *')).toBe('Every 10 minutes every day')
  })
})

describe('describeCron — the two composers are reachable for single values too', () => {
  test('a single minute and hour WITH A MONTH uses buildTimeDesc\'s At-form', () => {
    // The `Every day at HH:MM` early return requires dom='*' AND month='*' AND
    // dow='*'. Setting ONLY the month skips every early return, so buildTimeDesc's
    // own At-branch is what answers. Without a month here the branch is unreachable,
    // because with dom='*' the dedicated `On day N` return fires instead.
    expect(describeCron('30 9 * 3 *')).toBe('At 09:30 month March')
  })

  test('a single minute with hour=* and a MONTH uses the "every hour" form', () => {
    const out = describeCron('30 * * 3 *')
    expect(out).toContain('Every hour at minute 30')
    // The invalid-cron guard does not fire, and the month is still reported.
    expect(out).not.toBe('Invalid cron expression')
  })
})
