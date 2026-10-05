/**
 * Intent without a model call: the clarification rules, and "let routing decide whether to retrieve".
 *
 * WHY (measured 2026-10-05, 150 questions run through BOTH the intent model and the tool selector): on 100 document
 * and data questions the intent model never changed the outcome for the better — its only "no retrieval" verdicts were
 * 4 book questions it got wrong, and it asked 2 needless clarifying questions on answerable ones; on 5 vague questions
 * its clarifications matched these rules exactly (3 of 3); on 40 general questions the selector chose plain chat for
 * 37 and a web fetch for the 3 current-fact ones (GDP, population). The call cost ~3,000 tokens per question (the
 * largest prompt of the turn). The selector already decides chat vs. a tool, so the rule path keeps every decision and
 * drops the call. `INTENT_MODEL=true` restores the model.
 */
import type { IntentAnalysis } from '@/lib/intent-pipeline'

export function intentModelEnabled(): boolean {
  return process.env.INTENT_MODEL === 'true'
}

/**
 * Does this question name WHAT is being asked about?
 *
 * WHY THIS IS CODE AND NOT PROMPT. The intent prompt has always listed "a pronoun reference with
 * no antecedent" and "a date-range question with no clear time frame" as the two cases that require
 * clarification — and beneath them a "CRITICAL — DEFAULT TO NOT CLARIFYING" block saying that
 * "how many X?" is NOT ambiguous. Measured against the real provider, the model applies the
 * emphatic block to questions with NO X, and answers instead of asking. All four of the prompt's
 * OWN examples failed, twice — once with the original wording and once after a rewrite that
 * narrowed the block and explained the failure inline:
 *
 *     "How many of those are there?"  -> answered
 *     "Show me recent data."          -> answered
 *     "Berapa banyak dari itu?"       -> answered
 *     "Tampilkan data terbaru."       -> answered
 *
 * The result is not a silent no-op: "Berapa banyak itu?" produced a confident
 * "Jumlahnya 2.405 (total stok)" for a pronoun with no antecedent, chosen from one of three
 * connected databases. A user cannot tell that number is a guess.
 *
 * So the rule is enforced where it can be tested. Regexes, not an LLM call: a model cannot be
 * relied on to gate itself, and this must hold on every request.
 *
 * DELIBERATELY NARROW. It fires only when the question has NO subject at all — never when a noun
 * is present, even a vague one. A false clarification blocks a real answer, which is worse than
 * answering a vague question, so the patterns below cover only the unambiguous shapes.
 */
export function needsClarificationByRule(question: string): {
  needed: boolean
  /** Stable branch key — never match on `reason`, which is prose and may be reworded. */
  kind?: 'subject' | 'time'
  reason?: string
} {
  const q = question.trim().toLowerCase()

  // A pronoun/demonstrative with nothing to refer to. Requires the question to be SHORT and to
  // contain no concrete noun — "berapa jumlah karyawan itu?" names karyawan and must pass through.
  const PRONOUN_ONLY =
    /\b(itu|tersebut|tadi|yang tadi|dari itu|those|these|them|that one|the previous one|the above)\b/
  // SHORT is enforced, not just documented: a long question carries its own referents even when they are not in the
  // NOUNS list. MEASURED on the live eval: a 33-word question naming a sales tariff, a fuel surcharge and a finance
  // policy ended "Which of these two percentages is higher?" and was answered "What should I count?".
  const words = q.split(/\s+/).filter(Boolean).length
  if (PRONOUN_ONLY.test(q) && words <= 8) {
    const NOUNS = /\b(karyawan|pelanggan|pesanan|produk|gudang|stok|pengiriman|departemen|cuti|absensi|invoice|order|customer|product|employee|warehouse|shipment|document|dokumen|laporan|report)\b/
    if (!NOUNS.test(q)) return { needed: true, kind: 'subject', reason: 'pronoun with no antecedent' }
  }

  // "recent"/"terbaru"/"latest" — ambiguous ONLY when neither a time frame NOR a subject is named.
  // "Show me recent orders" is answerable: `orders` says which table to read, and it is the caller
  // who decides how far back a list goes. Blocking it would cost the user a real answer, which is
  // the worse error, so a named subject counts as sufficient context exactly like a time frame.
  // "data" is deliberately NOT treated as a subject: "Tampilkan data terbaru." names no entity at
  // all, and that is precisely the case the prompt documents as needing clarification.
  const RECENT = /\b(terbaru|terakhir|belakangan|recent|recently|latest|baru-baru ini)\b/
  const FRAME =
    /\b(hari ini|minggu ini|bulan ini|tahun ini|kemarin|kuartal|quarter|today|yesterday|this week|this month|this year|last week|last month|last year|\d{4}|\d+\s*(hari|minggu|bulan|tahun|day|week|month|year|jam|hour)s?)\b/
  const SUBJECT =
    /\b(karyawan|pelanggan|pesanan|produk|gudang|stok|pengiriman|departemen|cuti|absensi|pemasok|supplier|invoice|transaksi|order|orders|customer|customers|product|products|employee|employees|warehouse|shipment|shipments|payment|payments|document|documents|dokumen|laporan|report|reports)\b/
  if (RECENT.test(q) && !FRAME.test(q) && !SUBJECT.test(q)) {
    return { needed: true, kind: 'time', reason: 'relative time with no frame and no subject' }
  }

  return { needed: false }
}

/** The intent verdict from rules alone: retrieve (routing decides the tool, or chat), clarify only by rule. */
export function intentByRule(question: string): IntentAnalysis {
  const rule = needsClarificationByRule(question)
  if (!rule.needed) return { needsRetrieval: true, needsClarification: false, confidence: 0.5 }
  return {
    needsRetrieval: true,
    needsClarification: true,
    clarificationQuestion: rule.kind === 'time'
      ? 'Which time period do you mean? For example: this week, this month, or a specific date range.'
      : 'What should I count? For example: employees, customers, or orders.',
    confidence: 0.5,
  }
}
