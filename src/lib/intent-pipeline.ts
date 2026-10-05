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
// Namespace import for the two names added after `@/lib/rag` was already mocked with a partial surface in several
// test files: a NAMED import of a name a mock omits throws at module-evaluation time and surfaces as an unrelated
// file failing. Read off the namespace, a missing name is just `undefined` and the caller degrades.
import * as ragNs from '@/lib/rag'
import { stampRetrievedRanks } from '@/lib/retrieval-rank'
import { isPlaceholderChunk } from '@/lib/rag-chunking'
import type { ChatHistoryEntry } from '@/lib/tool-utils'
import { wrapUntrusted } from './evidence-boundary'
import { expandQuery } from '@/lib/query-expansion'
import { needsClarificationByRule } from '@/lib/intent-by-rule'
export { needsClarificationByRule } from '@/lib/intent-by-rule'
import { coverageMerge, decomposeForRetrieval, retrieveCompound } from '@/lib/rag-decompose'
import { mergeRetrievalResults, type RetrievalResult } from '@/lib/retrieval-merge'
export { mergeRetrievalResults } from '@/lib/retrieval-merge'
export { expandQuery } from '@/lib/query-expansion'

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

Rules:
- "Hello" / "Thanks" / "What is Python?" → no retrieval needed`

/**
 * The long-form clarification rules, sent as a SECOND user message rather than inside the system
 * prompt.
 *
 * WHY THEY ARE NOT IN THE SYSTEM PROMPT: MEASURED against the customer's provider, a system
 * message above ~2100 characters is DISCARDED ENTIRELY — not truncated. Reported `prompt_tokens`
 * for an otherwise identical request:
 *
 *     1900 chars -> 269 tokens   (delivered)
 *     2300 chars ->  44 tokens   (dropped; 44 is the user message alone)
 *
 * 3/3 identical in both directions, so it is a stable limit and not provider noise. This prompt
 * was 2872 characters — ALWAYS over it — so `analyzeIntent` never saw its own instructions. The
 * model replied in prose, `parseIntentJson` failed, and the function returned its safe defaults
 * (`needsRetrieval: true, needsClarification: false`) after spending seconds on the call. That is
 * also why round 7's ambiguity rule looked like the model ignoring it: the model was never told.
 *
 * Splitting keeps the instructions under the ceiling and puts the bulky list where a large block
 * is harmless.
 */
const INTENT_CLARIFICATION_RULES = `CRITICAL — DEFAULT TO NOT CLARIFYING:
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

Output ONLY valid JSON (no markdown fence). Exactly these keys:
{
  "needsRetrieval": true|false,
  "needsClarification": true|false,
  "clarificationQuestion": "one focused question or null"
}
Do NOT emit a rewritten query, entities, or a confidence score. Callers read only the three keys
above: MEASURED by grepping for consumers, "rewrittenQuery", "entities" and "confidence" were
produced and parsed but read by NOTHING — follow-up rewriting goes through the separate
rewriteQuery() call in tool-router.ts. Asking for them cost tokens and model effort on every
request for no effect.`


/**
 * Does the question explicitly point at a document ("according to the book", "in the excerpt", "menurut dokumen")?
 * Deliberately phrase-based and narrow: it only forces retrieval when the user said where the answer is.
 */
export function namesDocumentSource(question: string): boolean {
  return /\b(according to (the |this |our )?(book|excerpt|text|passage|document|documents|policy|sop|report|manual|handbook)|(in|from) (the|this) (book|excerpt|text|passage|document|policy|sop|report|manual)|the excerpt|menurut (dokumen|buku|kutipan|teks|kebijakan|sop|laporan|pedoman)|(dalam|di|pada) (dokumen|buku|kutipan|teks|kebijakan|sop|pedoman) (ini|tersebut)|berdasarkan (dokumen|buku|kebijakan|sop|pedoman))\b/i.test(question)
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
      {
        role: 'user',
        content: INTENT_CLARIFICATION_RULES,
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
    // A question that NAMES its source is a retrieval question, whatever the model judged. MEASURED on the
    // 2026-10-05 live eval: "According to the excerpt, in what year were the Clean Air Act Amendments passed?" was
    // routed to plain chat and answered "I don't see an excerpt in our conversation".
    if (args.hasDocuments && namesDocumentSource(args.question)) {
      parsed.needsRetrieval = true
      parsed.needsClarification = false
      parsed.clarificationQuestion = undefined
    }

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

/**
 * How much of the evidence the judge reads. It was 2,000 characters — under half of a 4-chunk context (581 characters
 * per chunk on average, compound questions up to 8 chunks) — so a missing hop could not be seen and the second pass
 * never ran (retrieval-recall.ts, 2026-10-05).
 */
const REFLECTION_EVIDENCE_CHARS = 8000

const REFLECTION_SYSTEM_PROMPT = `You are a reflection evaluator for a RAG system. Given the user's question and the retrieved evidence, determine if the evidence is SUFFICIENT to answer the question.

Rules:
- "Sufficient" means the evidence contains information that directly addresses the question
- If the evidence is about a different topic → insufficient
- If the evidence is tangentially related but doesn't answer the question → insufficient
- If the evidence partially answers but key details are missing → insufficient
- If the question asks for several facts, or for a figure that must be combined from several facts (a total, a
  difference, a value looked up via another value), the evidence is sufficient only if EVERY one of them is present
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

  // RAG_REFLECTION=false: no judge call and so no second pass — the deterministic checks above still apply.
  if (process.env.RAG_REFLECTION === 'false') return { sufficient: true, reason: 'reflection disabled', confidence: 0 }

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
        content: `Question: ${args.question}\n\n${wrapUntrusted('CONTEXT (EVIDENCE TO ASSESS):', args.evidence.slice(0, REFLECTION_EVIDENCE_CHARS), { withRule: true })}\n\nIs the evidence above sufficient to answer the question?`,
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
// Expanded retrieval — runs the variants `expandQuery` (query-expansion.ts) produces and merges their results.
// ---------------------------------------------------------------------------

// ponytail: cap expansions at 3 to limit parallel retrieval calls.
// Ceiling: 3x retrieval calls per RAG query. The RAG cache absorbs repeats.
const MAX_EXPANSIONS = 3

export async function retrieveWithReflection(args: {
  query: string
  topK: number
  /**
   * Restrict EVERY pass to these documents. `null`/absent = every document.
   *
   * Forwarded to each query expansion AND to the second reflection pass. A scope applied to the
   * first pass only would let the reflection step widen the search back out — a gap that leaves no
   * trace, because the answer still reads as plausible and its citations are all real.
   */
  documentIds?: string[] | null
  /**
   * Aborted when the caller no longer needs this retrieval. Used by the speculative start (speculative-retrieval.ts):
   * a turn the router sends to SQL, REST, a plugin or plain chat has no use for a sufficiency verdict, and that
   * verdict is an LLM call on the customer's own key. Checked BEFORE the reflection call and before the second pass
   * — the points where the next step costs a model call. Stages already in flight (the rerank) are not interrupted.
   */
  signal?: AbortSignal
}): Promise<RetrievalResult & {
  reflection: ReflectionResult
  retrievalPasses: number
}> {
  // 0. A compound question: standalone sub-questions, each searched and kept (rag-decompose.ts). Simple: [query], no call.
  const subQuestions = await decomposeForRetrieval(args.query)
  let merged: RetrievalResult, perSub: RetrievedChunk[][] = [], k = args.topK
  const rerankOn = typeof ragNs.rerankMergedChunks === 'function' && ragNs.ragRerankEnabled?.() === true
  const compound = (subs: string[]) => retrieveCompound({
    question: args.query, subQuestions: subs, topK: args.topK, expand: expandQuery, merge: mergeRetrievalResults,
    retrieve: (q) => retrieveRelevantChunks({ query: q, topK: args.topK, documentIds: args.documentIds, _skipRerank: rerankOn, _skipDecompose: true, signal: args.signal }),
    rerank: rerankOn ? ragNs.rerankMergedChunks : null,
  })
  if (subQuestions.length > 1) {
    ;({ merged, perSub, topK: k } = await compound(subQuestions))
  } else {
    // 1. Expand query with synonyms + multilingual variants
    const expansions = expandQuery(args.query).slice(0, MAX_EXPANSIONS)

    // 2. Retrieve with all expansions in parallel, merge + dedupe by chunkId
    //
    // RERANK ONCE, NOT ONCE PER EXPANSION. Each expansion used to run its own LLM rerank over its own candidates, so a
    // three-variant query paid for three rerank calls (MEASURED: up to 3 `rag-rerank` calls in one turn, ~2 s each and
    // billed to the customer's key). The expansions now return their un-reranked candidate pools; the pools are merged
    // by agreement and ONE rerank picks the final members from the union. With a single expansion nothing is deferred,
    // so that path is byte-for-byte what it was.
    const canDeferRerank = expansions.length > 1 && rerankOn
    const allResults = await Promise.all(
      expansions.map((q) =>
        retrieveRelevantChunks({ query: q, topK: args.topK, documentIds: args.documentIds, _skipRerank: canDeferRerank, signal: args.signal }),
      ),
    )
    args.signal?.throwIfAborted()
    merged = mergeRetrievalResults(allResults)
    if (canDeferRerank) {
      // The pool is capped at the size ONE retrieval would have handed the reranker, so the prompt does not grow with
      // the number of expansions. `merged.chunks` is ordered by agreement then score, so the cap keeps the chunks the
      // most passes found.
      const pool = merged.chunks.slice(0, args.topK * 3)
      const reranked = await ragNs.rerankMergedChunks(args.query, pool, args.topK)
      merged = { ...merged, chunks: reranked }
    }
  }

  // 3. Reflect — is the evidence sufficient to answer?
  //
  // ponytail: placeholders are EXCLUDED from the evidence string. A document
  // whose extraction produced nothing is stored as "[Empty document: x.pdf]" so
  // retrieval can match on the filename, but that marker is not evidence: it
  // cannot answer anything, and passing it here made the sufficiency check
  // judge a 46-char string and inject "if the evidence doesn't contain the
  // answer, say so" — so the bot disclaimed knowledge it never received. See
  // `isPlaceholderChunk` for the full trace.
  args.signal?.throwIfAborted()
  const evidenceChunks = merged.chunks.slice(0, k).filter((c) => !isPlaceholderChunk(c.content))
  const evidence = evidenceChunks.map((c) => c.content).join('\n\n')
  const reflection = await evaluateEvidenceSufficiency({
    question: args.query,
    evidence,
  })

  // 4. Multi-turn: if reflection says insufficient, do one more pass with 2x topK
  if (!reflection.sufficient && merged.chunks.length > 0) {
    args.signal?.throwIfAborted()
    // Real evidence, not compound, yet insufficient: maybe an IMPLICIT multi-hop (grade -> budget table), one hop found.
    // The model splits it now and this pass retrieves hop by hop (retrieval-recall.ts misses of that shape, 2026-10-05).
    const forced = perSub.length === 0 && evidence ? await decomposeForRetrieval(args.query, { force: true }) : []
    const hops = forced.length > 1 ? await compound(forced) : null
    if (hops) ({ perSub, topK: k } = hops)
    const secondPass = hops?.merged ?? await retrieveRelevantChunks({
      query: args.query,
      topK: args.topK * 2,
      signal: args.signal,
      // Same scope as the first pass. Omitting it here is the subtle form of the bug: the first pass
      // would respect the scope and the reflection pass would quietly widen it back out.
      documentIds: args.documentIds,
    })
    const merged2 = mergeRetrievalResults([merged, secondPass])
    return {
      // Re-stamped: the per-query ranks carried by `merged`/`secondPass` describe the orders the individual
      // retrievals produced, and this is a NEW order after the merge and the select. The UI labels these
      // "Match #N", so the label has to come from the list the caller receives.
      chunks: stampRetrievedRanks(coverageMerge(selectTopRetrievedChunks(merged2.chunks, k * 2), perSub, k * 2)),
      queryTokens: merged2.queryTokens,
      candidatesScanned: merged2.candidatesScanned,
      graphContext: merged2.graphContext,
      reflection,
      retrievalPasses: 2,
    }
  }

  return {
    // Same reason as the second-pass return above: the merged order is new, so the ranks are re-stamped.
    chunks: stampRetrievedRanks(coverageMerge(selectTopRetrievedChunks(merged.chunks, k), perSub, k)),
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
