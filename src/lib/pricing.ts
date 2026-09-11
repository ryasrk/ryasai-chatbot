/**
 * Subscription pricing — single source of truth for pack amounts.
 * Amounts are IDR integers. The client NEVER sends an amount; routes look the
 * price up here. BILLING_PACKS_JSON overrides the table (validated, fail-closed
 * on invalid config so a typo can't silently sell packs at wrong prices).
 */

export interface BillingPack {
  months: number
  amountIdr: number
}

const DEFAULT_PACKS: BillingPack[] = [
  { months: 1, amountIdr: 100_000 },
  { months: 3, amountIdr: 270_000 },
  { months: 6, amountIdr: 480_000 },
  { months: 12, amountIdr: 840_000 },
]

function parsePacks(raw: string | undefined): BillingPack[] {
  if (!raw) return DEFAULT_PACKS

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('BILLING_PACKS_JSON is not valid JSON — refusing to serve pricing (fail closed).')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('BILLING_PACKS_JSON must be a non-empty array of {months, amountIdr}.')
  }

  const packs: BillingPack[] = []
  for (const entry of parsed) {
    const months = (entry as BillingPack).months
    const amountIdr = (entry as BillingPack).amountIdr
    if (!Number.isInteger(months) || months <= 0 || !Number.isInteger(amountIdr) || amountIdr <= 0) {
      throw new Error('BILLING_PACKS_JSON entries must have positive integer months and amountIdr.')
    }
    if (packs.some((p) => p.months === months)) {
      throw new Error(`BILLING_PACKS_JSON has duplicate month count: ${months}.`)
    }
    packs.push({ months, amountIdr })
  }
  packs.sort((a, b) => a.months - b.months)
  return packs
}

// ponytail: cache keyed on the raw env value — re-reads stay cheap but env
// changes (tests) take effect, and an invalid value keeps throwing at read time.
let cached: { raw: string | undefined; packs: BillingPack[] } | null = null

export function getPacks(): BillingPack[] {
  const raw = process.env.BILLING_PACKS_JSON
  if (cached && cached.raw === raw) return cached.packs
  const packs = parsePacks(raw)
  cached = { raw, packs }
  return packs
}

export function findPack(months: number): BillingPack | undefined {
  return getPacks().find((p) => p.months === months)
}
