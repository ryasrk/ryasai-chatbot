/**
 * Intent Pipeline — production-grade conversational RAG architecture.
 * ----------------------------------------------------------------------------
 * Replaces the naive "user asks → retrieve → answer" flow with:
 *
 *   User Query
 *      │
 *      ▼
 *   Conversation Memory (chat history + entity tracking)
 *      │
 *      ▼
 *   Intent Analyzer (LLM) — "Can I retrieve with what I have?"
 *      │
 *      ├─ Need clarification? → Ask ONE focused question (progressive slot filling)
 *      │
 *      └─ Enough info? → Contextual Query Rewriter
 *                         │
 *                         ▼
 *                   Query Expansion (synonyms + multilingual)
 *                         │
 *                         ▼
 *                   Retriever (hybrid: BM25 + vector + FTS)
 *                         │
 *                         ▼
 *                   Reranker (LLM-based, opt-in)
 *                         │
 *                         ▼
 *                   Reflection — "Was the evidence sufficient?"
 *                         │
 *                         ├─ Yes → Answer Generation
 *                         │
 *                         └─ No → Retrieve again (1 retry) or ask clarification
 *
 * Key principles:
 *   1. Users think in business problems, not database schemas
 *   2. Retrieval is NOT the first step — intent analysis comes first
 *   3. Ask ONE question (progressive slot filling), not a form
 *   4. Rewrite follow-ups into standalone queries ("What is the procedure?" → "procedure for annual leave")
 *   5. Verify evidence sufficiency before answering (reduces hallucination)
 */
import { chatOnce } from '@/lib/llm-client'
import { getRoleLlmConfig } from '@/lib/llm-config'
import { retrieveRelevantChunks, selectTopRetrievedChunks, type RetrievedChunk } from '@/lib/rag'
import { isPlaceholderChunk } from '@/lib/rag-chunking'
import type { ChatHistoryEntry } from '@/lib/tool-utils'
import { wrapUntrusted } from './evidence-boundary'

export interface IntentAnalysis {
  /** Can we answer/retrieve with the information currently available? */
  needsRetrieval: boolean
  /** Is clarification needed before retrieval? */
  needsClarification: boolean
  /** The single highest-value clarification question (if needed) */
  clarificationQuestion?: string
  /** What the user is really asking, rewritten as a standalone query */
  rewrittenQuery?: string
  /** Entities extracted from conversation context */
  entities?: Record<string, string>
  /** Confidence in the analysis (0-1) */
  confidence: number
}

// ---------------------------------------------------------------------------
// Intent Analyzer — determines if retrieval is needed and if clarification
// is required. Uses a single LLM call with structured JSON output.
// ---------------------------------------------------------------------------

const INTENT_SYSTEM_PROMPT = `You are an intent analyzer for an enterprise AI assistant. Analyze the user's question in the context of conversation history and determine:

1. Does this question need retrieval (documents/database lookup), or can it be answered directly?
2. Is there enough context to retrieve effectively, or do we need to ask for clarification?
3. If this is a follow-up question, rewrite it as a standalone search query.

Rules:
- "What is the procedure?" with history → rewrite to "procedure for [topic from history]"
- "Hello" / "Thanks" / "What is Python?" → no retrieval needed
- When rewriting, preserve the user's original language (English/Indonesian)

CRITICAL — DEFAULT TO NOT CLARIFYING:
- The system has a smart router that automatically selects the best database
  integration and generates appropriate SQL queries. You do NOT need to know
  which table or column to query — the system figures that out.
- When databases are available, questions like "how many X?",
  "total Y", "list Z" are NOT ambiguous — the system auto-selects the right table.
- NEVER ask "which database?" or "which table?" or "which system?" — the system
  resolves that automatically.
- NEVER ask the user to provide a table name, column name, or schema.
- Only ask for clarification when the question is TRULY unanswerable:
  (a) a pronoun reference with no antecedent ("how many of THOSE?"), or
  (b) a date-range question with no clear time frame ("show me recent data"), or
  (c) a question about a specific entity when multiple with same name exist
- If the question mentions any noun that matches a table or column name from
  the schema summaries AND databases are available, set needsRetrieval=true,
  needsClarification=false.
- If documents are available and the question asks about a procedure, policy,
  rule, guideline, or "what does [document] say", set needsRetrieval=true,
  needsClarification=false.
- If REST API endpoints are available and the question asks for data that one of
  them returns (stock levels, orders, prices, anything named in an endpoint
  description), set needsRetrieval=true, needsClarification=false. The endpoint
  list IS the data source: never answer that you lack access to an API, and never
  ask the user for a base URL or an API key, when a matching endpoint is listed.
  This rule exists because the list was already being sent to the model while the
  prompt said nothing about it, so the model fell through to needsRetrieval=false
  and the REST branch was never reached even with a working connector.

Output ONLY valid JSON (no markdown fence):
{
  "needsRetrieval": true|false,
  "needsClarification": true|false,
  "clarificationQuestion": "one focused question or null",
  "rewrittenQuery": "standalone search query or null",
  "entities": { "topic": "...", "document_type": "..." },
  "confidence": 0.0-1.0
}`

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
  if (PRONOUN_ONLY.test(q)) {
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

export async function analyzeIntent(args: {
  question: string
  chatHistory?: ChatHistoryEntry[]
  hasDocuments: boolean
  hasIntegrations: boolean
  documentNames?: string[]
  integrationNames?: string[]
  schemaSummaries?: string[]
  /** REST endpoint descriptions — same first-scan rationale as the others. */
  restEndpointSummaries?: string[]
  /** Whether a REST connector with at least one enabled endpoint exists. */
  hasRestApis?: boolean
}): Promise<IntentAnalysis> {
  const cfg = await getRoleLlmConfig('keyword')
  if (!cfg) {
    // ponytail: no LLM configured — skip intent analysis, return default
    return {
      needsRetrieval: args.hasDocuments || args.hasIntegrations || (args.hasRestApis ?? false),
      needsClarification: false,
      confidence: 0,
    }
  }

  // Build conversation context for the LLM
  const historyText = (args.chatHistory ?? [])
    .slice(-6) // last 3 turns (user + assistant)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')

  const contextFlags = [
    args.hasDocuments ? 'Documents available: yes' : 'Documents available: no',
    args.hasIntegrations ? 'Databases available: yes' : 'Databases available: no',
    // Without this line the model received the endpoint LIST but no statement that a
    // REST API exists at all, so it answered needsRetrieval=false and the REST branch
    // was never entered. The two flags above have always been present; REST was the
    // one source whose availability was never declared.
    args.hasRestApis ? 'REST APIs available: yes' : 'REST APIs available: no',
    args.documentNames && args.documentNames.length > 0
      ? `Documents (name [category] — what it is about):\n${args.documentNames.slice(0, 20).join('\n')}`
      : '',
    args.integrationNames && args.integrationNames.length > 0
      ? `Database names: ${args.integrationNames.slice(0, 20).join(', ')}`
      : '',
    args.schemaSummaries && args.schemaSummaries.length > 0
      ? `Database table descriptions:\n${args.schemaSummaries.slice(0, 40).join('\n')}`
      : '',
    args.restEndpointSummaries && args.restEndpointSummaries.length > 0
      ? `REST API endpoints (what each returns):\n${args.restEndpointSummaries.slice(0, 20).join('\n')}`
      : '',
  ].filter(Boolean).join('\n')

  try {
    const raw = await chatOnce(cfg, [
      { role: 'system', content: INTENT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Conversation history:\n${historyText || '(none)'}\n\nAvailable data sources:\n${contextFlags}\n\nUser question: ${args.question}`,
      },
    ], 0, 'intent-analysis')

  const parsed = parseIntentJson(raw)
    // ponytail: heuristic guard — LLM intent sometimes returns needsClarification=true
    // even when databases are available and the question contains clear domain nouns.
    // This was the root cause of the "chatbot asks endless clarification" bug.
    // When data sources are available and the question looks like a data query
    // (contains domain nouns or count/list words), force needsClarification=false.
    // hasRestApis BELONGS in this condition and was missing. This guard exists to
    // suppress a clarification question the model asks even when a data source could
    // answer it ("which database?"). A REST-only org has such a source, but with the
    // flag absent the guard never ran, so the model's needless clarification stood
    // and the request returned "I do not have access to the stock API" -- with a
    // working connector, three enabled endpoints, and REST APIs declared to the
    // model. Measured on the UAT: every REST question failed this way.
    if (parsed.needsClarification && (args.hasDocuments || args.hasIntegrations || (args.hasRestApis ?? false))) {
      const qLower = args.question.toLowerCase()
      // ponytail: heuristic guard — when data sources are available and the
      // question contains query-oriented words (count, list, how many, show,
      // total) or domain nouns from the schema summaries, force
      // needsClarification=false. The LLM intent analyzer sometimes asks
      // "which database?" even when the system auto-selects integrations.
      const QUERY_INDICATORS = [
        'count', 'jumlah', 'total', 'berapa', 'how many', 'list', 'daftar',
        'show', 'tampilkan', 'display', 'report', 'laporan', 'summary',
        'breakdown', 'detail', 'statistics', 'statistik',
      ]
      // Check if any schema table/column name appears in the question
      const schemaTerms = (args.schemaSummaries ?? []).join(' ').toLowerCase()
      const questionHasSchemaTerm = schemaTerms.split(/[^a-z0-9_]+/)
        .filter((w) => w.length >= 4 && !QUERY_INDICATORS.includes(w))
        .some((w) => qLower.includes(w))
      const hasQueryIndicator = QUERY_INDICATORS.some((n) => qLower.includes(n))
      if (hasQueryIndicator || questionHasSchemaTerm) {
        parsed.needsClarification = false
        parsed.clarificationQuestion = undefined
      }
    }

    // APPLIED OUTSIDE THE SUPPRESSION ABOVE, and that placement is the whole point. The model
    // returns needsClarification=FALSE for these questions, so a guard placed inside the
    // `if (parsed.needsClarification ...)` block never runs — measured: the rule detected all four
    // correctly in isolation and still had no effect, because it was unreachable.
    //
    // The documented ambiguity rule has therefore never fired: 'berapa' and 'how many' are in
    // QUERY_INDICATORS, so "Berapa banyak itu?" was suppressed as a data query even though it names
    // nothing to count, and the pipeline answered it from an arbitrarily auto-selected database.
    // One produced a confident "Jumlahnya 2.405 (total stok)" the user could not identify as a guess.
    const rule = needsClarificationByRule(args.question)
    if (rule.needed) {
      parsed.needsClarification = true
      // Match on a STABLE KEY, not on the human-readable reason string. That comparison was written
      // as `reason === 'relative time with no frame'` and the reason text later gained
      // "and no subject" — so it stopped matching and a time question was answered with the COUNT
      // clarification ("What should I count?" for "Tampilkan data terbaru."). Prose in a reason
      // field is documentation; branch on a key that cannot drift.
      parsed.clarificationQuestion =
        parsed.clarificationQuestion ||
        (rule.kind === 'time'
          ? 'Which time period do you mean? For example: this week, this month, or a specific date range.'
          : 'What should I count? For example: employees, customers, or orders.')
    }
    return parsed
  } catch (e) {
    console.warn('[intent] analyzeIntent LLM call failed:', e instanceof Error ? e.message : String(e))
    // ponytail: on LLM error, fall back to default — don't block the user
    return {
      needsRetrieval: args.hasDocuments || args.hasIntegrations || (args.hasRestApis ?? false),
      needsClarification: false,
      confidence: 0,
    }
  }
}

function parseIntentJson(raw: string): IntentAnalysis {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
  try {
    const json = JSON.parse(cleaned)
    return {
      needsRetrieval: json.needsRetrieval ?? true,
      needsClarification: json.needsClarification ?? false,
      clarificationQuestion: json.clarificationQuestion || undefined,
      rewrittenQuery: json.rewrittenQuery || undefined,
      entities: json.entities || undefined,
      confidence: typeof json.confidence === 'number' ? json.confidence : 0.5,
    }
  } catch (e) {
    console.warn('[intent] JSON parse failed for intent analysis:', e instanceof Error ? e.message : String(e))
    // JSON parse failed — return safe defaults
    return {
      needsRetrieval: true,
      needsClarification: false,
      confidence: 0,
    }
  }
}

// ---------------------------------------------------------------------------
// Contextual Query Rewriter — rewrites follow-up questions into standalone
// search queries using conversation context.
// ----------------------------------------------------------------------------

const REWRITE_SYSTEM_PROMPT = `You are a query rewriter for a conversational RAG system. Rewrite the user's follow-up question into a standalone search query that captures the full intent, including context from the conversation.

Examples:
- History: "Tell me about annual leave" → Follow-up: "What is the procedure?" → Rewrite: "procedure for annual leave"
- History: "Show me the payroll report" → Follow-up: "Who approves it?" → Rewrite: "who approves payroll"
- History: "Customer data" → Follow-up: "Show me the top 5" → Rewrite: "top 5 customers by total spent"
- History: (none) → Follow-up: "How do I apply for leave?" → Rewrite: "how to apply for leave"

Rules:
- Preserve the user's language (English/Indonesian)
- Keep it concise — this is a search query, not a sentence
- Include all relevant entities from the conversation
- If the question is already standalone, return it unchanged
- Output ONLY the rewritten query, no explanation`

export async function rewriteQuery(args: {
  question: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<string> {
  // Skip rewriting if no history (first turn — question is already standalone)
  if (!args.chatHistory || args.chatHistory.length === 0) {
    return args.question
  }

  const cfg = await getRoleLlmConfig('keyword')
  if (!cfg) return args.question

  const historyText = args.chatHistory
    .slice(-6)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')

  try {
    const rewritten = await chatOnce(cfg, [
      { role: 'system', content: REWRITE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Conversation:\n${historyText}\n\nFollow-up question: ${args.question}\n\nRewritten standalone query:`,
      },
    ], 0, 'query-rewrite')

    const cleaned = rewritten.trim().replace(/^["']|["']$/g, '')
    return cleaned || args.question
  } catch (e) {
    console.warn('[intent] query rewrite failed:', e instanceof Error ? e.message : String(e))
    return args.question
  }
}

// ---------------------------------------------------------------------------
// Reflection — verifies that retrieved evidence is sufficient to answer.
// Returns true if the evidence is enough, false if we need to retrieve again
// or ask for clarification.
// ----------------------------------------------------------------------------

const REFLECTION_SYSTEM_PROMPT = `You are a reflection evaluator for a RAG system. Given the user's question and the retrieved evidence, determine if the evidence is SUFFICIENT to answer the question.

Rules:
- "Sufficient" means the evidence contains information that directly addresses the question
- If the evidence is about a different topic → insufficient
- If the evidence is tangentially related but doesn't answer the question → insufficient
- If the evidence partially answers but key details are missing → insufficient
- If the evidence directly answers the question → sufficient
- Empty evidence → insufficient

Output ONLY valid JSON:
{
  "sufficient": true|false,
  "reason": "brief explanation",
  "confidence": 0.0-1.0
}`

export interface ReflectionResult {
  sufficient: boolean
  reason: string
  confidence: number
}

export async function evaluateEvidenceSufficiency(args: {
  question: string
  evidence: string
}): Promise<ReflectionResult> {
  // ponytail: skip reflection if evidence is empty — clearly insufficient
  if (!args.evidence || args.evidence.trim().length === 0) {
    return { sufficient: false, reason: 'No evidence retrieved', confidence: 1.0 }
  }

  // ponytail: skip reflection if evidence is very short (< 50 chars) — likely insufficient
  // ponytail: a placeholder is genuinely insufficient, and we know it WITHOUT
  // asking the model — it contains no document text at all.
  if (isPlaceholderChunk(args.evidence)) {
    return { sufficient: false, reason: 'Only placeholder content retrieved', confidence: 0.9 }
  }

  // ponytail: this used to be `evidence.length < 50 => insufficient`, a
  // length-based verdict with no LLM call. Measured against a real knowledge
  // base it produced FALSE NEGATIVES: "Tarif lembur hari kerja 1,5x upah per
  // jam." is 41 chars and a complete, correct answer, yet was declared
  // insufficient — which advanced retrieval to a second pass and made
  // tool-branches.ts inject "if the evidence doesn't contain the answer, say
  // so", i.e. it instructed the model to disclaim an answer it had. Length is
  // not a proxy for sufficiency; a short chunk is not a bad chunk. Real
  // judgement is delegated to the model below. The floor is kept only as a
  // guard against a degenerate string (whitespace/punctuation) that cannot
  // carry meaning, not as a quality signal.
  if (args.evidence.replace(/[^\p{L}\p{N}]/gu, '').length < 8) {
    return { sufficient: false, reason: 'Evidence has no substantive content', confidence: 0.8 }
  }

  const cfg = await getRoleLlmConfig('query')
  if (!cfg) {
    // No LLM — assume sufficient (let the answer generator handle it)
    return { sufficient: true, reason: 'No LLM for reflection — assuming sufficient', confidence: 0 }
  }

  try {
    const raw = await chatOnce(cfg, [
      { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
      {
        role: 'user',
        // Same treatment as the answer prompts: this evidence is CUSTOMER CONTENT, and a document
        // asking to be declared sufficient sits in instruction position when interpolated raw.
        // Higher stakes than the reflexion site — a document that talks its way past this check
        // suppresses the retrieval reflection pass entirely, which is a QUALITY effect a customer
        // would feel and could not attribute.
        content: `Question: ${args.question}\n\n${wrapUntrusted('CONTEXT (EVIDENCE TO ASSESS):', args.evidence.slice(0, 2000))}\n\nIs the evidence above sufficient to answer the question?`,
      },
    ], 0, 'reflection')

    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const json = JSON.parse(cleaned)
    return {
      sufficient: json.sufficient ?? true,
      reason: json.reason || 'unknown',
      confidence: typeof json.confidence === 'number' ? json.confidence : 0.5,
    }
  } catch (e) {
    console.warn('[intent] evidence sufficiency evaluation failed:', e instanceof Error ? e.message : String(e))
    // On error, assume sufficient — don't block the answer
    return { sufficient: true, reason: 'Reflection failed — assuming sufficient', confidence: 0 }
  }
}

// ---------------------------------------------------------------------------
// Query Expansion — expands a query with synonyms and multilingual variants.
// Used to improve retrieval recall.
// ----------------------------------------------------------------------------

// ponytail: common English↔Indonesian synonyms for enterprise terms.
// NOT database-specific — generic business vocabulary.
const QUERY_SYNONYMS: Record<string, string[]> = {
  leave: ['annual leave', 'vacation', 'cuti', 'cuti tahunan', 'time off'],
  policy: ['procedure', 'guideline', 'rule', 'kebijakan', 'prosedur'],
  invoice: ['bill', 'faktur', 'tagihan'],
  employee: ['staff', 'worker', 'karyawan', 'pegawai'],
  customer: ['client', 'pelanggan', 'nasabah'],
  product: ['item', 'produk', 'barang'],
  order: ['purchase', 'pesanan', 'pembelian'],
  salary: ['pay', 'compensation', 'gaji', 'upah'],
  revenue: ['income', 'sales', 'pendapatan'],
  report: ['summary', 'laporan', 'ringkasan'],
  approval: ['authorize', 'persetujuan', 'persetujuan'],
  request: ['application', 'permohonan', 'pengajuan'],
  meeting: ['session', 'rapat', 'pertemuan'],
  budget: ['funding', 'anggaran', 'dana'],
  contract: ['agreement', 'kontrak', 'perjanjian'],
  training: ['course', 'pelatihan', 'kursus'],
  performance: ['evaluation', 'kinerja', 'penilaian'],
  recruitment: ['hiring', 'rekrutmen', 'penerimaan'],
  reimbursement: ['expense', 'refund', 'penggantian'],
  travel: ['trip', 'perjalanan', 'dinas'],
  // ponytail: ADDED by the 2026-09 cross-lingual trial. These are the terms the
  // measured failures actually needed; the map above is English-keyed so an
  // Indonesian query could never reach it (see expandQuery). Keep entries in the
  // SAME shape — the reverse index below derives the Indonesian→English
  // direction automatically, so never add a second hand-written table.
  overtime: ['lembur'],
  rate: ['tarif', 'besaran'],
  working: ['kerja'],
  holiday: ['libur', 'hari libur'],
  day: ['hari'],
  annual: ['tahunan'],
  carryover: ['carry over', 'sisa', 'dibawa'],
  refund: ['pengembalian', 'penggantian'],
  purchase: ['pembelian', 'pembayaran'],
  tender: ['tender', 'lelang'],
  threshold: ['batas', 'ambang'],
  security: ['keamanan'],
  breach: ['kebocoran', 'insiden'],
  access: ['akses'],
  term: ['termin'],
  deadline: ['batas waktu'],
  wage: ['upah'],
  processing: ['proses', 'pemrosesan'],
  update: ['pembaruan'],
}

/**
 * Reverse index: Indonesian/variant term → the canonical key it belongs to.
 *
 * WHY (2026-09 cross-lingual trial, `trial/14-crosslingual.ts`): documents are
 * routinely authored in English (vendor handbooks, ISO policies) while users ask
 * in Indonesian. `expandQuery` only looked up `QUERY_SYNONYMS[token]`, i.e. the
 * ENGLISH key — so "berapa tarif lembur?" tokenized to tarif/lembur/hari/kerja,
 * none of which is a key, and expansion returned the query unchanged.
 * Measured: 5 of 11 Indonesian questions retrieved NOTHING (0 chunks) even though
 * the answer was present in the corpus, and the run scored 58% retrieval overall
 * against 100% for English phrasing. With no embedding provider configured the
 * lexical path is the only one left, so this bridge is load-bearing.
 *
 * Built from QUERY_SYNONYMS so the two directions cannot drift.
 */
const SYNONYM_REVERSE: Record<string, string[]> = (() => {
  const rev: Record<string, Set<string>> = {}
  for (const [key, syns] of Object.entries(QUERY_SYNONYMS)) {
    // The key itself is a canonical term for its own concept.
    ;(rev[key] ??= new Set()).add(key)
    for (const syn of syns) {
      const norm = syn.toLowerCase().trim()
      if (!norm) continue
      ;(rev[norm] ??= new Set()).add(key)
      // Multi-word synonyms contribute each content word, so "cuti tahunan"
      // makes both "cuti" and "tahunan" reach the `leave` concept.
      //
      // CAUTION: this is lossy for AMBIGUOUS words. "hari libur" (holiday)
      // contributes the bare word "hari", which collides with "hari" = day —
      // and once `hari` reached the `holiday` concept, translating
      // "Berapa hari proses refund..." produced "...holiday processing refund...",
      // which matched nothing. A regression measured in trial/14-crosslingual.ts
      // (refund-processing went hit -> miss). Sub-splitting therefore records the
      // word ONLY under the key it belongs to, and a later key that owns the word
      // as a PRIMARY synonym wins; see EXACT_ONLY below for how the translator
      // resolves the ambiguity.
      if (norm.includes(' ')) {
        for (const part of norm.split(/\s+/)) {
          if (part.length >= 3) (rev[part] ??= new Set()).add(key)
        }
      }
    }
  }
  return Object.fromEntries(
    Object.entries(rev).map(([k, v]) => [k, [...v]]),
  )
})()

/**
 * Words that are a PRIMARY (single-word) synonym of exactly one concept.
 *
 * A word reachable only by splitting a multi-word phrase ("hari" out of
 * "hari libur") must not outrank a word that is a concept's own exact synonym
 * ("hari" for `day`). Without this, "Berapa hari proses refund…" translated to
 * "…holiday processing refund…" and matched nothing.
 */
const PRIMARY_SYNONYM: Record<string, string[]> = (() => {
  const primary: Record<string, string[]> = {}
  for (const [key, syns] of Object.entries(QUERY_SYNONYMS)) {
    primary[key] = [key]
    for (const syn of syns) {
      const norm = syn.toLowerCase().trim()
      if (norm && !norm.includes(' ')) (primary[norm] ??= []).push(key)
    }
  }
  return primary
})()

export function expandQuery(query: string): string[] {
  const lower = query.toLowerCase()
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
  const expansions = [query]
  const seen = new Set<string>([query])

  const push = (candidate: string) => {
    if (candidate !== lower && !seen.has(candidate)) {
      seen.add(candidate)
      expansions.push(candidate)
    }
  }

  // Fully-translated variant FIRST — this is what actually retrieves from an
  // English corpus. Substituting one token at a time yields mixed-language
  // strings ("berapa tarif lembur pada day kerja?") whose remaining Indonesian
  // words match nothing, so they score no better than the original; measured in
  // trial/14-crosslingual.ts. Each token is mapped to its best English concept
  // and the whole query is rewritten, so English content words dominate.
  const translated = tokens.map((t) => {
    if (QUERY_SYNONYMS[t]) return t // already English
    // A word that is some concept's exact single-word synonym resolves to that
    // concept only — never to a concept that merely happens to contain it inside
    // a multi-word phrase.
    const exact = PRIMARY_SYNONYM[t]
    if (exact && exact.length === 1) return exact[0]
    const concepts = SYNONYM_REVERSE[t]
    return concepts?.find((c) => !c.includes(' ')) ?? concepts?.[0] ?? t
  })
  if (translated.some((t, i) => t !== tokens[i])) {
    push(translated.join(' '))
  }

  for (const token of tokens) {
    // Forward direction: an English token expands to its Indonesian variants.
    const syns = QUERY_SYNONYMS[token]
    if (syns) {
      for (const syn of syns) push(lower.replace(new RegExp(`\\b${token}\\b`, 'g'), syn))
      continue
    }
    // Reverse direction: an Indonesian/variant token expands to the canonical
    // English concept word, which is what the English corpus actually contains.
    const concepts = SYNONYM_REVERSE[token]
    if (concepts) {
      for (const concept of concepts) {
        push(lower.replace(new RegExp(`\\b${token}\\b`, 'g'), concept))
      }
    }
  }

  return expansions
}

// ---------------------------------------------------------------------------
// Multi-pass retrieval with query expansion + reflection.
// ----------------------------------------------------------------------------
// This is the production retrieval orchestrator that wraps the base
// retrieveRelevantChunks with:
//   1. Query expansion — synonym + multilingual variants for better recall
//   2. Reflection — LLM evaluates if evidence is sufficient to answer
//   3. Multi-turn — if reflection says insufficient, retrieves again with 2x topK
//
// Returns the same shape as retrieveRelevantChunks plus reflection metadata.
// ----------------------------------------------------------------------------

interface RetrievalResult {
  chunks: RetrievedChunk[]
  queryTokens: string[]
  candidatesScanned: number
  graphContext: string
  citationTrail?: Array<{ entity: string; relation: string; chunkId: string; relevance: number }>
}

// ponytail: cap expansions at 3 to limit parallel retrieval calls.
// Ceiling: 3x retrieval calls per RAG query. The RAG cache absorbs repeats.
const MAX_EXPANSIONS = 3

/**
 * Union of several retrieval passes, deduped by chunkId keeping the best score.
 *
 * Deliberately UNBOUNDED — callers must apply selectTopRetrievedChunks to the
 * result. 3 query expansions plus an optional second pass at 2x topK used to
 * reach the prompt whole, so a topK of 4 shipped ~20 chunks (~69K chars with
 * parent-doc prefixes): the cost of every RAG turn, and the best chunk buried
 * in the middle where models reliably miss it.
 */
export function mergeRetrievalResults(results: RetrievalResult[]): RetrievalResult {
  // MERGE BY AGREEMENT, NOT BY SCORE ALONE.
  //
  // `score` is per-QUERY, not cross-query: `lexicalFirst` assigns 1/(rank+1), so every pass
  // gives its own rank-1 chunk exactly 1.0. Sorting a merged pool by that number alone
  // therefore compares incomparable values, and every tie is resolved by Map insertion order
  // — which is to say arbitrarily. MEASURED on a compound question ("kapan pelatihan keamanan
  // informasi dilaksanakan dan berapa lama sertifikatnya berlaku?"): the ORIGINAL query
  // ranked 03-panduan-onboarding.md first and correctly, one synonym expansion ranked
  // 09-panduan-pelatihan first, and the merge put a third document (08-kebijakan-perjalanan-
  // dinas, which contains ZERO chunks about training) at rank 4 purely on tie order.
  //
  // So agreement is counted explicitly: a chunk found by more passes ranks above one found by
  // fewer, and the score only breaks ties WITHIN the same agreement count. That is the same
  // consensus principle RRF was reached for, applied where it actually helps.
  const agreement = new Map<string, number>()
  const seen = new Map<string, RetrievedChunk>()
  for (const r of results) {
    for (const chunk of r.chunks) {
      agreement.set(chunk.chunkId, (agreement.get(chunk.chunkId) ?? 0) + 1)
      const existing = seen.get(chunk.chunkId)
      if (!existing || chunk.score > existing.score) {
        seen.set(chunk.chunkId, chunk)
      }
    }
  }
  const chunks = [...seen.values()].sort(
    (a, b) =>
      (agreement.get(b.chunkId) ?? 0) - (agreement.get(a.chunkId) ?? 0) ||
      b.score - a.score ||
      // Final tie-break on chunkId, so the order is TOTAL. Two chunks the same number of
      // passes agreed on, with equal scores, must not depend on Map iteration order or the
      // result drifts between identical requests.
      a.chunkId.localeCompare(b.chunkId),
  )
  const queryTokens = [...new Set(results.flatMap((r) => r.queryTokens))]
  const candidatesScanned = results.reduce((sum, r) => sum + r.candidatesScanned, 0)
  const graphContext = results.map((r) => r.graphContext).filter(Boolean).join('\n\n')
  const citationTrail = results.flatMap((r) => r.citationTrail ?? [])
  return { chunks, queryTokens, candidatesScanned, graphContext, citationTrail: citationTrail.length > 0 ? citationTrail : undefined }
}

export async function retrieveWithReflection(args: {
  query: string
  topK: number
}): Promise<RetrievalResult & {
  reflection: ReflectionResult
  retrievalPasses: number
}> {
  // 1. Expand query with synonyms + multilingual variants
  const expansions = expandQuery(args.query).slice(0, MAX_EXPANSIONS)

  // 2. Retrieve with all expansions in parallel, merge + dedupe by chunkId
  const allResults = await Promise.all(
    expansions.map((q) => retrieveRelevantChunks({ query: q, topK: args.topK })),
  )
  const merged = mergeRetrievalResults(allResults)

  // 3. Reflect — is the evidence sufficient to answer?
  //
  // ponytail: placeholders are EXCLUDED from the evidence string. A document
  // whose extraction produced nothing is stored as "[Empty document: x.pdf]" so
  // retrieval can match on the filename, but that marker is not evidence: it
  // cannot answer anything, and passing it here made the sufficiency check
  // judge a 46-char string and inject "if the evidence doesn't contain the
  // answer, say so" — so the bot disclaimed knowledge it never received. See
  // `isPlaceholderChunk` for the full trace.
  const evidenceChunks = merged.chunks.slice(0, args.topK).filter((c) => !isPlaceholderChunk(c.content))
  const evidence = evidenceChunks.map((c) => c.content).join('\n\n')
  const reflection = await evaluateEvidenceSufficiency({
    question: args.query,
    evidence,
  })

  // 4. Multi-turn: if reflection says insufficient, do one more pass with 2x topK
  if (!reflection.sufficient && merged.chunks.length > 0) {
    const secondPass = await retrieveRelevantChunks({
      query: args.query,
      topK: args.topK * 2,
    })
    const merged2 = mergeRetrievalResults([merged, secondPass])
    return {
      chunks: selectTopRetrievedChunks(merged2.chunks, args.topK * 2),
      queryTokens: merged2.queryTokens,
      candidatesScanned: merged2.candidatesScanned,
      graphContext: merged2.graphContext,
      reflection,
      retrievalPasses: 2,
    }
  }

  return {
    chunks: selectTopRetrievedChunks(merged.chunks, args.topK),
    queryTokens: merged.queryTokens,
    candidatesScanned: merged.candidatesScanned,
    graphContext: merged.graphContext,
    reflection,
    retrievalPasses: 1,
  }
}

// ---------------------------------------------------------------------------
// Answer confidence evaluation — determines if the accumulated tool outputs
// contain enough information to answer the question confidently.
// ----------------------------------------------------------------------------

export interface ConfidenceResult {
  confident: boolean
  reason: string
  nextToolHint?: 'SQL' | 'RAG' | 'REST' | 'CHAT' | null
  confidence: number
}

const CONFIDENCE_SYSTEM_PROMPT = `You are an answer confidence evaluator for an enterprise AI assistant. Given a question and the evidence gathered from tool calls so far, determine if there is enough information to answer confidently.

Rules:
- If the evidence directly answers the question → confident=true
- If the evidence is partial but sufficient for a useful answer → confident=true
- If the evidence is empty, irrelevant, or contradictory → confident=false
- If confident=false, suggest which tool to call next: SQL (database data), RAG (documents), REST (external API), or CHAT (no more tools needed, answer from knowledge)

Output ONLY valid JSON (no markdown fence):
{
  "confident": true|false,
  "reason": "why confident or not",
  "nextToolHint": "SQL"|"RAG"|"REST"|"CHAT"|null,
  "confidence": 0.0-1.0
}`

export async function evaluateAnswerConfidence(args: {
  question: string
  evidence: string
}): Promise<ConfidenceResult> {
  // ponytail: evidence-emptiness checks come FIRST, ahead of the LLM-availability
  // gate. Ordering matters: when these sat below `if (!cfg)` they were
  // unreachable on a deployment with no LLM configured, so empty or
  // placeholder-only evidence was reported as "confident" — the one case where
  // the verdict is least trustworthy. Found by writing the tests.
  //
  // A placeholder is not evidence — say so without an LLM call.
  if (isPlaceholderChunk(args.evidence)) {
    return { confident: false, reason: 'only placeholder content', nextToolHint: null, confidence: 0 }
  }

  // ponytail: this used to be `!evidence || evidence.trim().length < 50`. Same
  // defect as the sufficiency gate above, and it matters MORE here: this drives
  // the agentic loop's "call another tool" decision, so a short-but-complete
  // answer (a one-line policy figure) was declared unconfident, the loop burned
  // another iteration, and the eventual answer was produced from a worse context
  // than the one that already held the answer. Length is not a proxy for
  // confidence; only an empty or content-free string short-circuits.
  if (!args.evidence || args.evidence.replace(/[^\p{L}\p{N}]/gu, '').length < 8) {
    return { confident: false, reason: 'insufficient evidence', nextToolHint: null, confidence: 0 }
  }

  const cfg = await getRoleLlmConfig('query')
  if (!cfg) {
    // ponytail: no LLM — assume confident, don't block the answer
    return { confident: true, reason: 'no LLM configured', confidence: 1.0 }
  }

  try {
    const raw = await chatOnce(cfg, [
      { role: 'system', content: CONFIDENCE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Question: ${args.question}\n\nEvidence gathered so far:\n${args.evidence.slice(0, 4000)}`,
      },
    ], 0, 'confidence-evaluation')

    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned) as ConfidenceResult
    return {
      confident: Boolean(parsed.confident),
      reason: String(parsed.reason ?? ''),
      nextToolHint: parsed.nextToolHint ?? null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    }
  } catch (e) {
    console.warn('[intent] confidence evaluation failed:', e instanceof Error ? e.message : String(e))
    // ponytail: on LLM error, assume confident — don't block the answer
    return { confident: true, reason: 'evaluation failed, proceeding with answer', confidence: 0.5 }
  }
}
