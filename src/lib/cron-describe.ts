import { parseCron, nextRun } from '@/lib/cron'

export function describeCron(expr: string): string {
  const cron = parseCron(expr)
  if (!cron) return 'Invalid cron expression'

  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return 'Invalid cron expression'

  const [minField, hourField, domField, monthField, dowField] = parts

  if (minField === '*' && hourField === '*' && domField === '*' && monthField === '*' && dowField === '*') {
    return 'Every minute'
  }

  const minStep = parseStep(minField)
  if (minStep && hourField === '*' && domField === '*' && monthField === '*' && dowField === '*') {
    return `Every ${minStep} minutes`
  }

  if (isSingleNumber(minField) && hourField === '*' && domField === '*' && monthField === '*' && dowField === '*') {
    return `Every hour at minute ${minField}`
  }

  const hourStep = parseStep(hourField)
  if (hourStep && minField === '0' && domField === '*' && monthField === '*' && dowField === '*') {
    return `Every ${hourStep} hours`
  }

  if (isSingleNumber(minField) && isSingleNumber(hourField) && domField === '*' && monthField === '*' && dowField === '*') {
    return `Every day at ${formatTime(Number(hourField), Number(minField))}`
  }

  if (isSingleNumber(minField) && isSingleNumber(hourField) && domField === '*' && monthField === '*' && dowField === '1-5') {
    return `Weekdays (Mon-Fri) at ${formatTime(Number(hourField), Number(minField))}`
  }

  if (isSingleNumber(minField) && isSingleNumber(hourField) && domField === '*' && monthField === '*' && (dowField === '0,6' || dowField === '6,0')) {
    return `Weekends (Sat-Sun) at ${formatTime(Number(hourField), Number(minField))}`
  }

  if (isSingleNumber(minField) && isSingleNumber(hourField) && domField === '*' && monthField === '*' && dowField !== '*') {
    const days = parseDayList(dowField)
    if (days) {
      return `Every ${days} at ${formatTime(Number(hourField), Number(minField))}`
    }
  }

  if (isSingleNumber(minField) && isSingleNumber(hourField) && domField !== '*' && monthField === '*' && dowField === '*') {
    return `On day ${domField} at ${formatTime(Number(hourField), Number(minField))}`
  }

  const timeDesc = buildTimeDesc(minField, hourField)
  const dateDesc = buildDateDesc(domField, monthField, dowField)
  return `${timeDesc} ${dateDesc}`.trim()
}

function parseStep(field: string): number | null {
  const m = field.match(/^\*\/(\d+)$/)
  if (m) return parseInt(m[1], 10)
  return null
}

function isSingleNumber(field: string): boolean {
  return /^\d+$/.test(field)
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function parseDayList(field: string): string | null {
  if (field.includes('-')) {
    const [lo, hi] = field.split('-').map((n) => parseInt(n, 10))
    if (isNaN(lo) || isNaN(hi)) return null
    const names: string[] = []
    for (let i = lo; i <= hi; i++) {
      names.push(DAY_NAMES[i === 7 ? 0 : i])
    }
    return names.join(', ')
  }

  const nums = field.split(',').map((n) => parseInt(n, 10))
  if (nums.some(isNaN)) return null
  if (nums.some((n) => n < 0 || n > 7)) return null

  const normalized = nums.map((n) => (n === 7 ? 0 : n))

  if (normalized.length === 1) return DAY_NAMES[normalized[0]]
  if (normalized.length === 2) return `${DAY_NAMES[normalized[0]]} and ${DAY_NAMES[normalized[1]]}`
  return normalized.map((n) => DAY_NAMES[n]).join(', ')
}

function formatTime(hour: number, minute: number): string {
  const h = String(hour).padStart(2, '0')
  const m = String(minute).padStart(2, '0')
  return `${h}:${m}`
}

function buildTimeDesc(minField: string, hourField: string): string {
  if (minField === '*' && hourField === '*') return 'Every minute'
  if (isSingleNumber(minField) && isSingleNumber(hourField)) {
    return `At ${formatTime(Number(hourField), Number(minField))}`
  }
  if (isSingleNumber(minField) && hourField === '*') {
    return `Every hour at minute ${minField}`
  }
  const hourStep = parseStep(hourField)
  if (hourStep && minField === '0') return `Every ${hourStep} hours`
  const minStep = parseStep(minField)
  if (minStep) return `Every ${minStep} minutes`
  return `Minute: ${minField}, Hour: ${hourField}`
}

function buildDateDesc(domField: string, monthField: string, dowField: string): string {
  const parts: string[] = []

  if (dowField === '1-5') parts.push('weekdays (Mon-Fri)')
  else if (dowField === '0,6' || dowField === '6,0') parts.push('weekends')
  else if (dowField !== '*') {
    const days = parseDayList(dowField)
    if (days) parts.push(`every ${days}`)
  }

  if (domField !== '*' && monthField === '*') parts.push(`day ${domField}`)
  if (monthField !== '*') {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    const monthNums = monthField.split(',').map(Number)
    parts.push(`month ${monthNums.map((n) => months[n - 1] || n).join(', ')}`)
  }

  return parts.length > 0 ? parts.join(', ') : 'every day'
}

export function formatRelativeTime(date: string | null, now: Date = new Date()): string {
  if (!date) return '-'
  const target = new Date(date)
  const diffMs = target.getTime() - now.getTime()
  const diffMin = Math.round(diffMs / 60000)
  const diffHour = Math.round(diffMin / 60)
  const diffDay = Math.round(diffHour / 24)

  if (Math.abs(diffMin) < 1) return 'now'
  if (Math.abs(diffMin) < 60) {
    return diffMin > 0 ? `in ${diffMin} minutes` : `${Math.abs(diffMin)} minutes ago`
  }
  if (Math.abs(diffHour) < 24) {
    return diffHour > 0 ? `in ${diffHour} hours` : `${Math.abs(diffHour)} hours ago`
  }
  if (Math.abs(diffDay) < 7) {
    return diffDay > 0 ? `in ${diffDay} days` : `${Math.abs(diffDay)} days ago`
  }
  return target.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function previewNextRuns(expr: string, from: Date = new Date(), count: number = 5): Date[] {
  const runs: Date[] = []
  let cursor = from
  for (let i = 0; i < count; i++) {
    const next = nextRun(expr, cursor)
    if (!next) break
    runs.push(next)
    cursor = new Date(next.getTime() + 60000)
  }
  return runs
}

export const SCHEDULE_PRESETS: Array<{ expr: string; label: string; description: string }> = [
  { expr: '* * * * *', label: 'Every minute', description: 'Every minute' },
  { expr: '*/5 * * * *', label: 'Every 5 minutes', description: 'Every 5 minutes' },
  { expr: '*/15 * * * *', label: 'Every 15 minutes', description: 'Every 15 minutes' },
  { expr: '*/30 * * * *', label: 'Every 30 minutes', description: 'Every 30 minutes' },
  { expr: '0 * * * *', label: 'Every hour', description: 'Every hour at minute 0' },
  { expr: '0 */6 * * *', label: 'Every 6 hours', description: 'Every 6 hours' },
  { expr: '0 9 * * *', label: 'Daily 09:00', description: 'Every day at 09:00' },
  { expr: '0 18 * * *', label: 'Daily 18:00', description: 'Every day at 18:00' },
  { expr: '0 9 * * 1', label: 'Weekly (Mon)', description: 'Every Monday at 09:00' },
  { expr: '0 9 * * 1-5', label: 'Weekdays 09:00', description: 'Weekdays (Mon-Fri) at 09:00' },
  { expr: '0 10 * * 6', label: 'Saturday 10:00', description: 'Every Saturday at 10:00' },
  { expr: '0 0 1 * *', label: 'Start of month', description: 'On day 1 at 00:00' },
  { expr: '0 0 * * 0', label: 'Sunday night', description: 'Every Sunday at 00:00' },
]
