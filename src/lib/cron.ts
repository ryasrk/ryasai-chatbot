/**
 * Minimal 5-field cron parser + next-run calculator.
 * ===========================================================================
 * Fields: minute (0-59) · hour (0-23) · day-of-month (1-31) · month (1-12)
 * · day-of-week (0=Sun, 7=Sun, 1-6=Mon-Sat).
 *
 * Supports: wildcard, numbers, ranges (1-5), lists (1,3,5), step values
 * (star/15, 1-10/2).
 *
 * All comparisons use UTC — the scheduler process runs in UTC so that
 * schedules are deterministic regardless of server timezone.
 */

export interface CronMatch {
  match: (date: Date) => boolean
}

// Field bounds: [min, max] for each of the 5 positions.
const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 7], // day-of-week (0 and 7 both = Sunday)
]

/**
 * Parse a single cron field into a set of matching integers.
 * Returns null on any parse error (non-numeric, out of bounds, empty).
 */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>()
  for (const part of field.split(',')) {
    const slashIdx = part.indexOf('/')
    const rangePart = slashIdx >= 0 ? part.slice(0, slashIdx) : part
    const stepPart = slashIdx >= 0 ? part.slice(slashIdx + 1) : undefined

    const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1
    if (stepPart !== undefined && (Number.isNaN(step) || step < 1)) return null

    let lo: number
    let hi: number
    if (rangePart === '*') {
      lo = min
      hi = max
    } else if (rangePart.includes('-')) {
      const dashIdx = rangePart.indexOf('-')
      lo = Number.parseInt(rangePart.slice(0, dashIdx), 10)
      hi = Number.parseInt(rangePart.slice(dashIdx + 1), 10)
      if (Number.isNaN(lo) || Number.isNaN(hi)) return null
    } else {
      lo = Number.parseInt(rangePart, 10)
      if (Number.isNaN(lo)) return null
      // `N/step` means N-max/step; `N` alone means just N.
      hi = stepPart !== undefined ? max : lo
    }

    if (lo < min || hi > max || lo > hi) return null
    for (let v = lo; v <= hi; v += step) result.add(v)
  }
  return result.size > 0 ? result : null
}

export function parseCron(expr: string): CronMatch | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null

  const parsed = fields.map((f, i) => parseField(f, FIELD_BOUNDS[i][0], FIELD_BOUNDS[i][1]))
  if (parsed.some((s) => s === null)) return null

  const [minutes, hours, doms, months, dowsRaw] = parsed as Set<number>[]

  // Normalise DOW: 7 → 0 (both mean Sunday).
  const dows = new Set<number>()
  for (const d of dowsRaw!) dows.add(d === 7 ? 0 : d)

  // Vixie cron: when both DOM and DOW are restricted (not `*`), match if
  // EITHER matches. When only one is restricted, that one must match.
  const domRestricted = fields[2] !== '*'
  const dowRestricted = fields[4] !== '*'

  return {
    match(date: Date): boolean {
      if (!minutes!.has(date.getUTCMinutes())) return false
      if (!hours!.has(date.getUTCHours())) return false
      if (!months!.has(date.getUTCMonth() + 1)) return false
      const dom = date.getUTCDate()
      const dow = date.getUTCDay()
      if (domRestricted && dowRestricted) return doms!.has(dom) || dows.has(dow)
      if (domRestricted && !doms!.has(dom)) return false
      if (dowRestricted && !dows.has(dow)) return false
      return true
    },
  }
}

export function nextRun(expr: string, from: Date): Date | null {
  const cron = parseCron(expr)
  if (!cron) return null

  // ponytail: minute-by-minute scan, fast enough for cron — max 525600 iterations per call
  const cursor = new Date(from.getTime())
  // Start from the next minute boundary — we want the next match strictly AFTER `from`.
  cursor.setUTCSeconds(0, 0)
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)

  const maxIter = 366 * 24 * 60
  for (let i = 0; i < maxIter; i++) {
    if (cron.match(cursor)) return new Date(cursor.getTime())
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)
  }
  return null
}
