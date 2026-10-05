/**
 * Which of MANY sources to show the model, ranked by relevance to the question instead of by position.
 *
 * WHY (measured with a recorder model standing in for the provider, 2026-10-03; six databases of 3–40 tables and
 * three REST APIs with 50 endpoints): routing showed each database as the first 8 of an UNORDERED first 25 tables,
 * and the REST chooser as "the first 40" endpoints. The table that answered a leave question (`HR.leave_balances`,
 * one of 40) and a shipment question (`Logistics.shipments`) were both absent from the prompt, and the
 * shipment-tracking endpoint — 15th of the third API — was never offered, so even a model that always picks
 * correctly could not call it. A source the model is not shown can never be chosen.
 *
 * The ranking is lexical and deterministic: shared words between the question (plus any translated phrasings the
 * caller supplies) and the source's own words. Ties keep the caller's order, and `interleaveBy` keeps every group
 * represented when nothing matches, so no API or database disappears wholesale.
 */

/** English plural to singular, enough for table and endpoint names: categories->category, boxes->box, balances->balance. */
function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

/** Lowercased word stems: split on non-letters/digits and camelCase, short words dropped, plurals singularised. */
export function relevanceTokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
    .map(singular)
}

/** How many of the question's word stems the candidate shares (prefix match from 4 characters, both directions). */
export function relevanceScore(candidate: string, questionTokens: Set<string>): number {
  let score = 0
  for (const t of new Set(relevanceTokens(candidate))) {
    for (const q of questionTokens) {
      if (t === q || (t.length >= 4 && q.length >= 4 && (t.startsWith(q) || q.startsWith(t)))) {
        score++
        break
      }
    }
  }
  return score
}

/**
 * Order `items` most-relevant first. `phrasings` is the question plus any rewordings (e.g. translations); a word in
 * any of them counts. Stable: equal scores keep their input order.
 */
export function rankByRelevance<T>(items: T[], textOf: (item: T) => string, phrasings: string[]): T[] {
  const q = new Set(phrasings.flatMap(relevanceTokens))
  return items
    .map((item, index) => ({ item, index, score: q.size ? relevanceScore(textOf(item), q) : 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item)
}

/**
 * Rank, then take `limit`, with every group represented: relevant items first (by score), and the remaining slots
 * filled round-robin across groups so one large group cannot crowd the others out.
 */
export function selectRelevant<T>(
  items: T[],
  textOf: (item: T) => string,
  groupOf: (item: T) => string,
  phrasings: string[],
  limit: number,
): T[] {
  const q = new Set(phrasings.flatMap(relevanceTokens))
  const scored = items.map((item, index) => ({ item, index, score: q.size ? relevanceScore(textOf(item), q) : 0 }))
  const relevant = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)
  const out = relevant.slice(0, limit).map((x) => x.item)
  if (out.length >= limit) return out

  const rest = new Map<string, T[]>()
  for (const x of scored) {
    if (x.score > 0) continue
    const g = groupOf(x.item)
    const list = rest.get(g) ?? []
    list.push(x.item)
    rest.set(g, list)
  }
  const queues = [...rest.values()]
  while (out.length < limit && queues.some((qu) => qu.length > 0)) {
    for (const qu of queues) {
      const next = qu.shift()
      if (next !== undefined && out.length < limit) out.push(next)
    }
  }
  return out
}
