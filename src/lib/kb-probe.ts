/**
 * A lexical check of the knowledge base, for a question the router would answer from general knowledge.
 *
 * WHY (live eval, 2026-10-05): questions about an uploaded 1 MB book, phrased like general knowledge ("What accord …
 * was established in 2016?"), were routed to plain chat and answered from the model's own memory — contradicting the
 * organisation's document. The intent model cannot know what the documents contain; one full-text query can.
 *
 * The check is deliberately cheap and strict: no model call, one statement, and "strong" only when ONE chunk holds most
 * of the question's content words. Calibrated on the live-eval corpus (24 policy documents + the book): 60% and at
 * least 3 terms caught 20 of the 24 book questions and 1 of 40 general-knowledge questions — and that one ("How does
 * climate change affect agriculture?") is a topic the book covers. A caller that acts on a strong probe must still
 * fall back to chat when retrieval does not support an answer.
 */
import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'

export const KB_PROBE_MIN_FRACTION = 0.6
export const KB_PROBE_MIN_TERMS = 3
/** More terms add little evidence and make the statement long. */
const MAX_TERMS = 16

const STOP_WORDS = new Set(`the a an and or of to in on at for from with by about as is are was were be been being this that these those
what which who whom whose when where why how many much does did do can could would should will shall may might into over under
than then there their they them its it his her our your you we me my per each also any some such more most other only same very
just according described describe excerpt book text passage document documents stated state says say said time year years
percent percentage number total main kind type part parts based between during after before while within without upon
yang dan atau dari ke di pada untuk dengan oleh tentang adalah ialah itu ini apa siapa kapan dimana mengapa bagaimana berapa
apakah dalam sebagai juga saja lebih paling setiap tiap per menurut berdasarkan tersebut sebuah suatu para bagi`.split(/\s+/))

/**
 * The question's content words, lower-cased and de-duplicated: words of 4+ letters that are not stop words, plus 4-digit
 * numbers (years). Only letters and digits survive, so nothing that is a tsquery operator can reach the statement.
 */
export function probeTerms(question: string): string[] {
  const words = question.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const kept = words.filter((w) => (/^\d+$/.test(w) ? w.length === 4 : w.length >= 4 && !STOP_WORDS.has(w)))
  return [...new Set(kept)].sort().slice(0, MAX_TERMS)
}

export async function probeKnowledgeBase(args: {
  question: string
  /** Retrieval scope. `null`/absent/empty = every document (the convention in `access-scope.ts`). */
  documentIds?: string[] | null
}): Promise<{ strong: boolean; matched: number; terms: number }> {
  const terms = probeTerms(args.question)
  const weak = { strong: false, matched: 0, terms: terms.length }
  // Raw SQL bypasses the tenant extension: without an org there is no scope to bind, so nothing is read.
  const orgId = getOrgContext()
  if (!orgId || terms.length < KB_PROBE_MIN_TERMS) return weak

  const scoped = args.documentIds && args.documentIds.length > 0 ? args.documentIds : null
  // $1 org, $2 any-term query, $3.. one per term, then the document scope.
  const perTerm = terms.map((_, i) => `(tsv @@ to_tsquery('simple', $${i + 3}))::int`).join(' + ')
  const scopeParam = terms.length + 3
  try {
    const rows = await db.$queryRawUnsafe<Array<{ hit: number }>>(
      `SELECT (${perTerm}) AS hit FROM "DocumentChunk"
       WHERE "organizationId" = $1 AND tsv @@ to_tsquery('simple', $2)${scoped ? ` AND "documentId" = ANY($${scopeParam})` : ''}
       ORDER BY hit DESC LIMIT 1`,
      orgId,
      terms.join(' | '),
      ...terms,
      ...(scoped ? [scoped] : []),
    )
    const matched = Number(rows[0]?.hit ?? 0)
    return { strong: matched >= KB_PROBE_MIN_TERMS && matched / terms.length >= KB_PROBE_MIN_FRACTION, matched, terms: terms.length }
  } catch {
    // A failed probe must not change routing: the turn proceeds exactly as it would have without it.
    return weak
  }
}
