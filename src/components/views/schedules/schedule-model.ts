/**
 * Schedule data shapes and the pure helpers behind the schedules view: the cron <-> form mapping and the time-zone
 * formatting. No React, so the mapping is testable on its own.
 */

export type RepeatType = 'daily' | 'weekdays' | 'weekends' | 'custom'

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface NotificationConfig {
  id: string
  name: string
  type: string
  isActive: boolean
}

export interface IntegrationOption {
  id: string
  name: string
  type: string
  provider: string
  status: string
}

export const QUICK_PRESETS = [
  { label: 'Every minute', cron: '* * * * *' },
  { label: 'Every 5 min', cron: '*/5 * * * *' },
  { label: 'Every 15 min', cron: '*/15 * * * *' },
  { label: 'Every 30 min', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily 9 AM', cron: '0 9 * * *' },
  { label: 'Daily 6 PM', cron: '0 18 * * *' },
  { label: 'Weekdays 9 AM', cron: '0 9 * * 1-5' },
  { label: 'First of month', cron: '0 9 1 * *' },
]

export function buildCron(time: string, repeat: RepeatType, selectedDays: number[]): string {
  const [h, m] = time.split(':').map(Number)
  const hh = h ?? 0
  const mm = m ?? 0
  if (repeat === 'daily') return `${mm} ${hh} * * *`
  if (repeat === 'weekdays') return `${mm} ${hh} * * 1-5`
  if (repeat === 'weekends') return `${mm} ${hh} * * 0,6`
  if (repeat === 'custom' && selectedDays.length > 0) return `${mm} ${hh} * * ${selectedDays.sort().join(',')}`
  return `${mm} ${hh} * * *`
}

/**
 * The simple form (time + repeat + days) for a cron expression, or `null` when the form cannot express it.
 *
 * Only an expression the form can rebuild EXACTLY is accepted, checked by round trip through `buildCron`. Anything
 * else (a day of month, a step such as every-15-minutes, a named weekday) used to be read as "daily" at whatever the first two
 * fields parsed to, so saving the dialog unchanged rewrote the schedule — see `cronForEdit`.
 */
export function parseCron(expr: string): { time: string; repeat: RepeatType; selectedDays: number[] } | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [mm, hh, dom, month, dow] = parts
  if (!/^\d{1,2}$/.test(mm) || !/^\d{1,2}$/.test(hh) || Number(mm) > 59 || Number(hh) > 23 || dom !== '*' || month !== '*') return null
  const time = `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`
  let form: { time: string; repeat: RepeatType; selectedDays: number[] }
  if (dow === '*') form = { time, repeat: 'daily', selectedDays: [] }
  else if (dow === '1-5') form = { time, repeat: 'weekdays', selectedDays: [] }
  else if (dow === '0,6') form = { time, repeat: 'weekends', selectedDays: [] }
  else if (/^[0-6](,[0-6])*$/.test(dow)) form = { time, repeat: 'custom', selectedDays: dow.split(',').map(Number) }
  else return null
  return buildCron(form.time, form.repeat, [...form.selectedDays]) === parts.join(' ') ? form : null
}

/**
 * The edit dialog's initial state for a stored expression: the simple form when it can express it, otherwise the
 * expression itself as `customCron`, which the dialog saves as written.
 */
export function cronForEdit(expr: string): { time: string; repeat: RepeatType; selectedDays: number[]; customCron: string | null } {
  const form = parseCron(expr)
  return form ? { ...form, customCron: null } : { time: '09:00', repeat: 'daily', selectedDays: [], customCron: expr }
}

export interface Schedule {
  id: string
  name: string
  cronExpr: string
  prompt: string
  isActive: boolean
  lastRunAt: string | null
  nextRunAt: string | null
  lastResult: string | null
  notificationConfigId: string | null
  integrationId: string | null
  timezone: string
  createdAt: string
  updatedAt: string
}

export const BROWSER_TIMEZONE = (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC'

// ponytail: Intl.supportedValuesOf isn't in every runtime's lib.d.ts target —
// feature-detect and fall back to a curated list covering major regions.
export const TIMEZONES: string[] = (() => {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone')
    if (supported && supported.length > 0) return supported
  } catch {}
  return [
    'UTC', 'Asia/Jakarta', 'Asia/Singapore', 'Asia/Bangkok', 'Asia/Manila', 'Asia/Kuala_Lumpur',
    'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Kolkata', 'Asia/Dubai',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
    'Australia/Sydney', 'Pacific/Auckland',
  ]
})()

export function fmtDate(date: string | null, timezone: string = 'UTC'): string {
  if (!date) return '-'
  return fmtInTz(new Date(date), timezone)
}

export function fmtInTz(date: Date, timezone: string, withComma: boolean = false): string {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = fmt.formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('day')} ${get('month')} ${get('year')}${withComma ? ',' : ''} ${get('hour')}:${get('minute')}`
}

export function lastStatusFromResult(lastResult: string | null): 'success' | 'error' | null {
  if (!lastResult) return null
  try {
    const parsed = JSON.parse(lastResult)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) return 'error'
    return 'success'
  } catch {
    return null
  }
}

export interface RunHistoryItem {
  id: string
  status: string
  answer: string | null
  error: string | null
  toolRuns: Array<{ type: string; status: string; outputSummary?: string }> | null
  latencyMs: number | null
  executedAt: string
}
