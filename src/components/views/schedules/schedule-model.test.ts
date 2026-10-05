import { describe, expect, test } from 'bun:test'
import { QUICK_PRESETS, buildCron, cronForEdit, parseCron } from '@/components/views/schedules/schedule-model'

/** What the edit dialog saves when the user changes nothing: the custom expression if kept, else the rebuilt one. */
function savedUnchanged(expr: string): string {
  const form = cronForEdit(expr)
  return form.customCron ?? buildCron(form.time, form.repeat, form.selectedDays)
}

describe('editing a schedule keeps its cron expression', () => {
  // MEASURED DEFECT: opening "First of month" (0 9 1 * *) in the edit dialog read it as daily 09:00, and saving —
  // even just to rename it — stored `0 9 * * *`. Seven of the ten quick presets were rewritten the same way.
  test.each(QUICK_PRESETS.map((p) => [p.label, p.cron]))('%s (%s) survives open → save unchanged', (_label, cron) => {
    expect(savedUnchanged(cron)).toBe(cron)
  })

  test.each([
    ['0 9 * * *', { time: '09:00', repeat: 'daily', selectedDays: [] }],
    ['30 7 * * 1-5', { time: '07:30', repeat: 'weekdays', selectedDays: [] }],
    ['0 18 * * 0,6', { time: '18:00', repeat: 'weekends', selectedDays: [] }],
    ['15 8 * * 1,3,5', { time: '08:15', repeat: 'custom', selectedDays: [1, 3, 5] }],
  ])('%s is shown in the simple form', (cron, form) => {
    expect(parseCron(cron)).toEqual(form as never)
    expect(cronForEdit(cron).customCron).toBeNull()
  })

  test.each(['0 9 1 * *', '*/15 * * * *', '0 */6 * * *', '0 9 * 1 *', '0 9 * * MON', 'garbage'])(
    '%s cannot be shown in the simple form, so it is kept as written',
    (cron) => {
      expect(parseCron(cron)).toBeNull()
      expect(cronForEdit(cron).customCron).toBe(cron)
    },
  )
})
