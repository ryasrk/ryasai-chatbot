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
import type { ChatHistoryEntry } from '@/lib/tool-utils'

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

Output ONLY valid JSON (no markdown fence):
{
  "needsRetrieval": true|false,
  "needsClarification": true|false,
  "clarificationQuestion": "one focused question or null",
  "rewrittenQuery": "standalone search query or null",
  "entities": { "topic": "...", "document_type": "..." },
  "confidence": 0.0-1.0
}`

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
}): Promise<IntentAnalysis> {
  const cfg = await getRoleLlmConfig('keyword')
  if (!cfg) {
    // ponytail: no LLM configured — skip intent analysis, return default
    return {
      needsRetrieval: args.hasDocuments || args.hasIntegrations,
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
    if (parsed.needsClarification && (args.hasDocuments || args.hasIntegrations)) {
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
    return parsed
  } catch (e) {
    console.warn('[intent] analyzeIntent LLM call failed:', e instanceof Error ? e.message : String(e))
    // ponytail: on LLM error, fall back to default — don't block the user
    return {
      needsRetrieval: args.hasDocuments || args.hasIntegrations,
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
  if (args.evidence.trim().length < 50) {
    return { sufficient: false, reason: 'Evidence too short', confidence: 0.8 }
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
        content: `Question: ${args.question}\n\nEvidence:\n${args.evidence.slice(0, 2000)}\n\nIs this evidence sufficient?`,
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
}

export function expandQuery(query: string): string[] {
  const lower = query.toLowerCase()
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
  const expansions = [query]

  for (const token of tokens) {
    const syns = QUERY_SYNONYMS[token]
    if (syns) {
      for (const syn of syns) {
        // Replace the token with the synonym in the original query
        const expanded = lower.replace(new RegExp(`\\b${token}\\b`, 'g'), syn)
        if (expanded !== lower) expansions.push(expanded)
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
  const seen = new Map<string, RetrievedChunk>()
  for (const r of results) {
    for (const chunk of r.chunks) {
      const existing = seen.get(chunk.chunkId)
      if (!existing || chunk.score > existing.score) {
        seen.set(chunk.chunkId, chunk)
      }
    }
  }
  const chunks = [...seen.values()].sort((a, b) => b.score - a.score)
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
  const evidence = merged.chunks
    .slice(0, args.topK)
    .map((c) => c.content)
    .join('\n\n')
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
  const cfg = await getRoleLlmConfig('query')
  if (!cfg) {
    // ponytail: no LLM — assume confident, don't block the answer
    return { confident: true, reason: 'no LLM configured', confidence: 1.0 }
  }

  if (!args.evidence || args.evidence.trim().length < 50) {
    return { confident: false, reason: 'insufficient evidence', nextToolHint: null, confidence: 0 }
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
