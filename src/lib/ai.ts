/**
 * AI Client — routes completions to a configured OpenAI/Anthropic-compatible
 * endpoint (set via /api/llm-config). Fail-closed: throws when no LLM is
 * configured. Mirrors spec §7 (`app/ai/agent.py`) — temperature=0 for
 * deterministic Text-to-SQL.
 *
 * Responsibilities:
 *   - routeQuery(): decide whether a user question needs SQL, RAG, or chit-chat.
 *   - generateSql(): Text-to-SQL given a reflected schema + question.
 *   - generateAnswer(): final NL answer from SQL rows / RAG context.
 *   - streamAnswer(): token-by-token streaming for the HTTP SSE pipeline.
 */
import { getLlmRuntimeConfig, type LlmRuntimeConfig } from '@/lib/llm-config'
import { chatOnce as llmChatOnce, chatStream as llmChatStream } from '@/lib/llm-client'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { db } from '@/lib/db'
import { LlmNotConfiguredError } from '@/lib/errors'

// ---------------------------------------------------------------------------
// Backend resolution + shared completion helpers
// ---------------------------------------------------------------------------

type ChatRole = 'system' | 'user' | 'assistant'
interface ChatMessage {
  role: ChatRole
  content: string
}

interface ChatOpts {
  temperature?: number
  purpose?: string
}

async function resolveBackend(): Promise<{ cfg: LlmRuntimeConfig }> {
  const cfg = await getLlmRuntimeConfig()
  if (cfg && cfg.baseUrl && cfg.apiKey) return { cfg }
  throw new LlmNotConfiguredError()
}

/** Non-streaming completion. Returns the trimmed message content. */
async function chatOnce(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const { cfg } = await resolveBackend()
  const temperature = opts.temperature ?? 0
  return llmChatOnce(cfg, messages, temperature, opts.purpose ?? 'chat')
}

/** Streaming completion — yields token chunks. */
async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOpts = {},
): AsyncGenerator<string, void, unknown> {
  const { cfg } = await resolveBackend()
  const temperature = opts.temperature ?? 0
  yield* llmChatStream(cfg, messages, temperature, opts.purpose ?? 'chat')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RouteDecision = 'SQL' | 'RAG' | 'REST' | 'CHAT' | 'CONTEXTUAL_CHAT' | 'PLUGIN'

export interface RoutingContext {
  question: string
  hasIntegrations: boolean
  hasDocuments: boolean
  hasRestApis?: boolean
  memoryContext?: string
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
}

/**
 * LLM router. Decides which pipeline to run.
 * Uses deterministic prompting (temp=0) per spec §7.
 */
export async function routeQuery(ctx: RoutingContext): Promise<{
  decision: RouteDecision
  reason: string
}> {
  const hasHistory = ctx.chatHistory && ctx.chatHistory.length > 0
  const historyText = hasHistory
    ? ctx.chatHistory!.slice(-8)
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 400)}`)
        .join('\n')
    : ''

  const [tableSchemas, documents, restEndpoints] = await Promise.all([
    db.integrationSchema.findMany({
      where: { integration: { status: 'active' } },
      select: { tableName: true, description: true, integration: { select: { name: true } } },
    }),
    db.document.findMany({ where: { status: 'ready', isEnabled: true }, select: { name: true, category: true } }),
    db.restApiEndpoint.findMany({ where: { isEnabled: true }, select: { path: true, description: true } }),
  ])
  const tableNames = tableSchemas.map((t) => t.tableName)
  const tableDescriptions = tableSchemas
    .filter((t) => t.description)
    .map((t) => `${t.integration.name}.${t.tableName}: ${t.description}`)
  const docNames = documents.map((d) => (d.category ? `${d.name} [${d.category}]` : d.name))
  const apiPaths = restEndpoints.map((e) => e.path)

  const decisionRaw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'You are an enterprise AI router. Determine the handling ROUTE for the user message. ' +
          'Answer ONLY with one word: SQL, RAG, REST, CHAT, or CONTEXTUAL_CHAT.\n' +
          '- SQL: questions about structured data in connected databases — any question asking for ' +
          'counts, totals, lists, or data from database tables. If the question asks "how many", ' +
          '"berapa", "count", "total", "list", "show me", and databases are available, route to SQL.\n' +
          '- RAG: questions about policies, SOPs, documents, procedures, guidelines, regulations, or non-structural text.\n' +
          '- REST: questions that need to call whitelisted REST API endpoints on external systems.\n' +
          '- CHAT: greetings, small talk, or general questions that do not need internal data.\n' +
          '- CONTEXTUAL_CHAT: the user refers to a previous conversation OR provides new information/facts.\n' +
          '  Examples of CONTEXTUAL_CHAT:\n' +
          '  - "mention your answer again" → CONTEXTUAL_CHAT (not SQL)\n' +
          '  - "what product did I ask about earlier?" → CONTEXTUAL_CHAT (not SQL)\n' +
          '  - "how much does it cost?" (without mentioning a product) → CONTEXTUAL_CHAT (not SQL, because "it" = the cost of the product discussed earlier)\n' +
          '  - "the best-selling product is SKU-902 with 5800 units" → CONTEXTUAL_CHAT (not SQL, because the user is stating a fact, not asking)\n' +
          '  - "I want to say that..." → CONTEXTUAL_CHAT\n' +
          '  Examples of SQL/RAG (not CONTEXTUAL_CHAT):\n' +
          '  - "what is the stock of SKU-902?" → SQL (specific product mentioned + asking for data)\n' +
          '  - "what is the stock opname procedure?" → RAG (asking about a document)\n' +
          '  IMPORTANT RULE: if the message does NOT end with a question mark AND contains the words "is/that is/namely", it is likely a statement → CONTEXTUAL_CHAT.\n' +
          '  IMPORTANT: When databases are available and the question asks about data (counts, lists, ' +
          'totals, or mentions any table/entity name), prefer SQL over CHAT. Do NOT route to CHAT ' +
          'just because the question does not mention "sales" or "customers" — any structured data ' +
          'question goes to SQL.',
      },
      {
        role: 'user',
        content:
          `Question: "${ctx.question}"\n` +
          `Context: database integrations available=${ctx.hasIntegrations}, knowledge base documents available=${ctx.hasDocuments}, REST APIs available=${ctx.hasRestApis ?? false}.\n` +
          (tableNames.length > 0 ? `Database tables: ${tableNames.slice(0, 30).join(', ')}\n` : '') +
          (tableDescriptions.length > 0 ? `Table descriptions:\n${tableDescriptions.slice(0, 30).join('\n')}\n` : '') +
          (docNames.length > 0 ? `Documents: ${docNames.slice(0, 30).join(', ')}\n` : '') +
          (apiPaths.length > 0 ? `REST APIs: ${apiPaths.slice(0, 20).join(', ')}\n` : '') +
          (ctx.memoryContext ? `Memory from prior interactions:\n${ctx.memoryContext}\n` : '') +
          (hasHistory ? `Prior conversation history:\n${historyText}\n` : '') +
          `Answer only SQL / RAG / REST / CHAT / CONTEXTUAL_CHAT.`,
      },
    ],
    { purpose: 'router' },
  )
  const raw = decisionRaw.toUpperCase().trim()
  const decision: RouteDecision = raw.includes('CONTEXTUAL')
    ? 'CONTEXTUAL_CHAT'
    : raw.startsWith('SQL')
      ? 'SQL'
      : raw.startsWith('RAG')
        ? 'RAG'
        : raw.startsWith('REST')
          ? 'REST'
          : 'CHAT'
  // ponytail: lightweight plugin check — keyword match only, no LLM call.
  // If a relevant plugin exists, route to PLUGIN so tool-router executes it.
  // Filter by chatEnabled — this runs in the chat path (routeQuery is called
  // from resolveRouting in tool-router.ts, which is the chat completion flow).
  if (decision === 'CHAT') {
    const relevant = await selectRelevantPlugins({ query: ctx.question, topK: 1, minScore: 0.05, context: 'chat' })
    if (relevant.length > 0) {
      return { decision: 'PLUGIN', reason: `Plugin ${relevant[0].name} is relevant (score ${relevant[0].score.toFixed(2)})` }
    }
  }
  return { decision, reason: `Router LLM selected ${decision}` }
}

/**
 * Text-to-SQL generator (spec §3 + §7).
 * Returns raw SQL — caller MUST run it through guardrails.validateAndSanitizeLlmSql.
 */
export async function generateSql(args: {
  question: string
  schemaDescription: string
  provider: string
  dialectHint?: string
  memoryContext?: string
  systemPromptPrefix?: string
  /** Rich business context: domain overview, glossary, relationships, query hints */
  businessContext?: string | null
  /** Repair feedback from a failed execution — fed back for a corrected retry. */
  repairFeedback?: string
}): Promise<{ sql: string; explanation: string }> {
  const raw = await chatOnce(
    [
      {
        role: 'system',
        content:
          `You are an expert ${args.provider} Text-to-SQL specialist. ` +
          'Your task: convert a natural language question into ONE valid & efficient SELECT query. ' +
          'RULES:\n' +
          '1. ONLY SELECT is allowed. INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE are FORBIDDEN.\n' +
          '2. Always include LIMIT when relevant (maximum 100 rows).\n' +
          '3. Use only tables & columns that exist in the following schema.\n' +
          '4. Format your answer as JSON: {"sql": "...", "explanation": "..."}.\n' +
          '5. Do not wrap with markdown code fence.\n' +
          '6. When filtering by date, always cast string literals to the column type, e.g. WHERE order_date >= DATE \'2026-07-30\' or WHERE order_date::date = CURRENT_DATE. Never compare a date column directly to a bare string literal.\n' +
          '7. "hari ini" / "today" means CURRENT_DATE. "kemarin" / "yesterday" means CURRENT_DATE - 1.\n' +
          '8. If the question mentions a date but does not specify one, use CURRENT_DATE.\n' +
          '9. IMPORTANT: Always double-quote table and column names to preserve case sensitivity. ' +
          'For example, use "SELECT COUNT(*) FROM "participants" WHERE "IsDeleted" = false" ' +
          'NOT "SELECT COUNT(*) FROM participants WHERE IsDeleted = false". ' +
          'PostgreSQL lowercases unquoted identifiers, which causes "column does not exist" errors ' +
          'when the actual column name has uppercase letters.\n' +
          '10. Do NOT filter by "IsDeleted" or "DeletedAt" unless the user asks about deleted records. ' +
          'Most count queries should count ALL rows (active + deleted) unless the user specifically ' +
          'asks for "active" or "non-deleted" records.\n' +
          '11. When asked for a TOTAL count, use SELECT COUNT(*) FROM "table" — do NOT add WHERE ' +
          'clauses unless the user specifies a filter.\n' +
          '12. Use the BUSINESS CONTEXT (if provided) to identify the correct table for domain ' +
          'terms. If the business context maps a domain term to a specific table, use that table.\n' +
          '13. String search is case-sensitive with =, LIKE, and IN — user data rarely is. When ' +
          'searching text (names, titles, statuses, keywords), always match case-insensitively: ' +
          'PostgreSQL: "name" ILIKE \'%john%\' (or LOWER("name") = LOWER(\'John\')); ' +
          'MySQL: LOWER(name) LIKE \'%john%\'; ' +
          'MSSQL: LOWER(name) LIKE \'%john%\'; ' +
          'ClickHouse: positionCaseInsensitive(name, \'john\') > 0. ' +
          'Never use bare = or case-sensitive LIKE for user-facing text search.\n' +
          '14. If the search term itself can contain % or _ (e.g. searching for "50% off"), escape ' +
          'the wildcards with an explicit ESCAPE clause (e.g. ... ILIKE \'%50^% off%\' ESCAPE \'^\'). ' +
          'Do not strip user-supplied wildcards silently — the user may intend them as wildcards.\n' +
          '15. NULL semantics: comparisons with NULL yield NULL (never true). Use IS NULL / ' +
          'IS NOT NULL for null checks, never = NULL. Use COALESCE(col, default) when comparing ' +
          'a nullable column for equality. LIKE/ILIKE on a NULL column returns NULL — add OR col IS NULL ' +
          'only if the user explicitly wants missing values included.\n' +
          '16. Prefer substring matches over exact matches when the user says "contains", "about", ' +
          '"menyebut", "terkait", "tentang", or provides a partial value; use exact case-insensitive ' +
          'equality (= with LOWER, or ILIKE without %) for "exactly", "persis", full identifiers.',
      },
      {
        role: 'user',
        content:
          `Dialect: ${args.provider}\n` +
          (args.businessContext
            ? `\n## BUSINESS CONTEXT\n${args.businessContext}\n`
            : '') +
          `\nDatabase schema:\n${args.schemaDescription}\n\n` +
          (args.systemPromptPrefix ? `Context: ${args.systemPromptPrefix}\n\n` : '') +
          (args.repairFeedback ? `PREVIOUS ATTEMPT FAILED — fix it. ${args.repairFeedback}\n\n` : '') +
          `User question: ${args.question}\n\n` +
          (args.memoryContext ? `Memory: a similar query previously succeeded with:\n${args.memoryContext}\n\n` : '') +
          `Provide JSON {"sql": "...", "explanation": "..."}.`,
      },
    ],
    { purpose: 'sql' },
  )
  return parseSqlJson(raw)
}

function parseSqlJson(raw: string): { sql: string; explanation: string } {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  try {
    const obj = JSON.parse(cleaned)
    return { sql: String(obj.sql ?? '').trim(), explanation: String(obj.explanation ?? '').trim() }
  } catch (e) {
    console.warn('[ai] SQL JSON parse failed, using raw text:', e instanceof Error ? e.message : String(e))
    return { sql: cleaned, explanation: 'Query generated by LLM.' }
  }
}

/**
 * Generate the final natural-language answer from SQL rows / RAG context.
 * Used by both the HTTP fallback and the WebSocket streaming service.
 */
export async function generateAnswer(args: {
  question: string
  context: string
  source: 'SQL' | 'RAG' | 'REST_API' | 'CHAT'
  provider?: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatMessage[]
  /** SQL/REST row count — enables honest empty-result and truncation reporting. */
  rowCount?: number
  /** True when the result was cut off by the LIMIT clamp (resultLimit reached). */
  truncated?: boolean
}): Promise<string> {
  const sourceLabel = answerContextLabel(args.source)
  const messages: ChatMessage[] = []
  if (args.systemPromptPrefix) {
    messages.push({ role: 'system', content: args.systemPromptPrefix })
  }
  if (args.memoryContext) {
    messages.push({ role: 'system', content: `Memory context from prior interactions:\n${args.memoryContext}` })
  }
  if (args.chatHistory && args.chatHistory.length > 0) {
    messages.push(...historyToMessages(args.chatHistory))
  }
  // ponytail: empty results and LIMIT truncation used to reach the synthesis
  // prompt as bare "[]" / 100 rows with no framing — the model either invented
  // an explanation or presented a truncated set as complete. Surface both
  // facts explicitly so it can be honest without hallucinating.
  const emptyNote =
    args.rowCount === 0
      ? `The query executed successfully but returned 0 rows. State plainly that no matching data was found for this question. Do NOT invent rows, do NOT fabricate an explanation for why it is empty — if the reason is not evident from the data, say the filter may be too narrow and suggest what the user could relax (date range, status filter, entity name). `
      : ''
  const truncatedNote =
    args.truncated
      ? `The result was TRUNCATED to the first ${args.rowCount} rows by the system row limit. Tell the user explicitly (e.g. "showing the first ${args.rowCount} matching rows") — never present a truncated set as the complete answer, and offer to narrow the question for a complete view. `
      : ''
  messages.push({
    role: 'system',
    content:
      `You are ryasai, an enterprise AI assistant. ` +
      `Answer the user's question based on the CONTEXT provided. ` +
      `If the question refers to prior data or conversation, use both the CONTEXT and the conversation history to answer. ` +
      `Do not say data is unavailable if it appears in the context or history. ` +
      emptyNote +
      truncatedNote +
      `If the CONTEXT marks a step FAILED, report that failure and its reason. ` +
      `Never invent data, and never substitute manual setup instructions for the user to run by hand. ` +
      `Format numbers for readability. ` +
      `Mention the data source naturally at the end of the answer.`,
  })
  messages.push({
    role: 'user',
    content:
      `Question: ${args.question}\n\n` +
      `CONTEXT (${sourceLabel}):\n${args.context}\n\n` +
      `Answer:`,
  })
  return chatOnce(messages, { purpose: 'synthesis' })
}

export function answerContextLabel(source: 'SQL' | 'RAG' | 'REST_API' | 'CHAT'): string {
  if (source === 'REST_API') return 'REST API'
  if (source === 'CHAT') return 'PRIOR CONTEXT'
  return source
}

/**
 * ponytail: rolling session summary — condenses messages that fell out of the
 * 10-message history window. Without it, anything older silently vanishes
 * from every prompt ("chatbot with amnesia" in long sessions). Called when
 * history exceeds the window; stored on ChatSession.summary.
 */
export async function generateSessionSummary(args: {
  previousSummary: string | null
  messages: ChatMessage[]
}): Promise<string> {
  const formatted = args.messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1000)}`)
    .join('\n')
  const raw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'Condense the conversation into a compact summary (max 200 words) that preserves: ' +
          'topics discussed, key facts/figures the user shared, entities mentioned by name, ' +
          'decisions or conclusions reached, and any open questions. ' +
          'If a previous summary exists, merge — keep older facts unless contradicted. ' +
          'Same language as the conversation. Output ONLY the summary text.',
      },
      {
        role: 'user',
        content:
          (args.previousSummary ? `Previous summary:\n${args.previousSummary}\n\n` : '') +
          `New messages to fold in:\n${formatted}`,
      },
    ],
    { purpose: 'summary' },
  )
  return raw.trim().slice(0, 2000)
}

/**
 * Session title from the first user message — 3-6 words, user's language.
 * ponytail: the old fallback (raw text.slice(0, 60)) produced titles like
 * "Berapa total pendapatan kami untuk kuartal..." — truncated mid-sentence.
 * Cheap single call; callers should treat failure as non-fatal and keep the
 * raw-text fallback.
 */
export async function generateSessionTitle(firstMessage: string): Promise<string> {
  const raw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'Create a short chat-session title (3-6 words) summarizing the user message. ' +
          'Use the SAME language as the message. Title case. No quotes, no trailing punctuation, ' +
          'no prefix like "Session:". Output ONLY the title.',
      },
      { role: 'user', content: firstMessage.slice(0, 500) },
    ],
    { purpose: 'title' },
  )
  const title = raw.replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 80)
  return title.length >= 3 ? title : firstMessage.slice(0, 60)
}

// ---------------------------------------------------------------------------
// Schema description generation — LLM summarizes each table's purpose from
// its columns + 1 sample row. Called once at connection test time, cached in
// IntegrationSchema.description. Used as context for intent analysis + routing.
// ----------------------------------------------------------------------------

export interface TableSummaryInput {
  tableName: string
  columns: Array<{ name: string; type: string; primaryKey?: boolean }>
  rowCount?: number | null
  sampleRow?: Record<string, unknown> | null
}

export async function generateSchemaDescriptions(args: {
  integrationName: string
  tables: TableSummaryInput[]
}): Promise<Record<string, string>> {
  if (args.tables.length === 0) return {}

  const tableTexts = args.tables.map((t) => {
    const cols = t.columns.map((c) => `${c.name}:${c.type}${c.primaryKey ? ' (PK)' : ''}`).join(', ')
    const sample = t.sampleRow ? `\n  Sample row: ${JSON.stringify(t.sampleRow).slice(0, 300)}` : ''
    const rows = t.rowCount != null ? ` (${t.rowCount} rows)` : ''
    return `Table: ${t.tableName}${rows}\n  Columns: ${cols}${sample}`
  }).join('\n\n')

  const raw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'You are a database schema analyst. For each table, write a concise 1-sentence description of what the table contains and its purpose. ' +
          'Focus on business meaning, not technical details. ' +
          'Output ONLY valid JSON (no markdown fence): {"tableName": "description", ...}',
      },
      {
        role: 'user',
        content:
          `Database: ${args.integrationName}\n\nTables:\n${tableTexts}\n\n` +
          `Generate a JSON object mapping each table name to a 1-sentence description.`,
      },
    ],
    { purpose: 'schema-description' },
  )

  try {
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    return JSON.parse(cleaned) as Record<string, string>
  } catch (e) {
    console.warn('[ai] schema reflection JSON parse failed:', e instanceof Error ? e.message : String(e))
    // ponytail: LLM returned malformed JSON — return empty, don't block schema reflection
    return {}
  }
}

// ---------------------------------------------------------------------------
// Database Profile generation — LLM analyzes the full schema and produces a
// rich business context document. This is the "what database is this?" answer
// that gets injected into every Text-to-SQL call so the model understands:
//   1. What business domain the database serves (mining safety, HR, e-commerce)
//   2. How tables relate to each other (participants → companies → sites)
//   3. Domain vocabulary (abbreviations, non-English terms)
//   4. Querying hints (which columns to filter on, what "active" means)
//
// Generated once at connection test time, stored in Integration.businessContext.
// ---------------------------------------------------------------------------

export async function generateDatabaseProfile(args: {
  integrationName: string
  tables: TableSummaryInput[]
}): Promise<string> {
  if (args.tables.length === 0) return ''

  const tableTexts = args.tables.map((t) => {
    const cols = t.columns.map((c) => `${c.name}:${c.type}${c.primaryKey ? ' (PK)' : ''}`).join(', ')
    const sample = t.sampleRow ? `\n  Sample: ${JSON.stringify(t.sampleRow).slice(0, 300)}` : ''
    const rows = t.rowCount != null ? ` (${t.rowCount} rows)` : ''
    return `${t.tableName}${rows}: ${cols}${sample}`
  }).join('\n')

  const raw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'You are a database analyst. Analyze the complete schema of a database and produce a ' +
          'BUSINESS CONTEXT document that will help a Text-to-SQL AI understand the domain. ' +
          'The document must be plain text (not JSON) with these sections:\n\n' +
          '## DOMAIN\nWhat business domain is this database for? (e.g. "HR and payroll", ' +
          '"e-commerce", "inventory management"). What organization type?\n\n' +
          '## CORE ENTITIES\nList the 5-10 most important tables and what they represent in business ' +
          'terms. Use the business name, not the table name.\n\n' +
          '## KEY RELATIONSHIPS\nHow do the core entities connect? (e.g. "employees belong to ' +
          'departments, have payroll records, attend training sessions")\n\n' +
          '## DOMAIN GLOSSARY\nDefine domain-specific terms and abbreviations found in table/column ' +
          'names. Include non-English terms if present.\n\n' +
          '## QUERY HINTS\nPractical tips for writing correct SQL:\n' +
          '- Which column indicates "active" status for key tables\n' +
          '- Which tables should be used for common business questions\n' +
          '- Which columns to avoid filtering on unnecessarily\n' +
          '- When to use COUNT(*) vs filtering (e.g. "for vendor count, count ALL companies — do NOT filter by name patterns")\n' +
          '- Common pitfalls (e.g. soft-delete columns, case sensitivity)\n' +
          '- For each core entity, note: which table to query, what "active" means, and what NOT to filter on\n\n' +
          'Keep it concise — aim for 300-500 words total. Do NOT include SQL examples.',
      },
      {
        role: 'user',
        content:
          `Database name: ${args.integrationName}\n\n` +
          `Complete schema (${args.tables.length} tables):\n${tableTexts}\n\n` +
          `Generate the business context document.`,
      },
    ],
    { purpose: 'schema-description' },
  )

  return raw.trim()
}

/** Pure non-streaming chat (no SQL/RAG) for external API and general questions. */
export async function generateChat(
  question: string,
  systemPromptPrefix?: string,
  memoryContext?: string,
  chatHistory?: ChatMessage[],
): Promise<string> {
  const messages: ChatMessage[] = []
  if (systemPromptPrefix) {
    messages.push({ role: 'system', content: systemPromptPrefix })
  }
  if (memoryContext) {
    messages.push({ role: 'system', content: `Memory context from prior interactions:\n${memoryContext}` })
  }
  messages.push({
    role: 'system',
    content:
      'You are ryasai, an enterprise AI assistant. ' +
      'You can help with: database queries (SQL), document search (RAG), REST API calls, and general chat. ' +
      'When the user refers to prior conversation or data, use the conversation history to answer without needing a new query. ' +
      'If the user provides new information, acknowledge and remember it. ' +
      'Do not say data is unavailable if it was discussed in prior conversation history.',
  })
  if (chatHistory && chatHistory.length > 0) {
    messages.push(...historyToMessages(chatHistory))
  }
  messages.push({ role: 'user', content: question })
  return chatOnce(messages, { purpose: 'chat' })
}

export interface RestEndpointOption {
  id: string
  connectorName: string
  method: string
  path: string
  description?: string | null
  parameterSchema?: string | null
  sampleResponse?: string | null
}

export interface RestCallPlan {
  endpointId: string
  query: Record<string, string | number | boolean | null>
  body: unknown
  explanation: string
}

export const REST_ROUTER_SYSTEM_PROMPT =
  'You are an enterprise REST API router. Select the ONE most relevant whitelisted endpoint to answer the user question. ' +
  'Do not create new paths. Use the endpointId exactly from the list. ' +
  'sampleResponse is only an example structure, not final data to answer the user. ' +
  'The explanation should briefly describe the reason for selecting the endpoint and the parameters sent. ' +
  'Do not send query or body if parameterSchema is empty or does not mention that parameter. ' +
  'Answer ONLY JSON without markdown: {"endpointId":"...","query":{},"body":null,"explanation":"..."}.\n' +
  'Use query for simple URL parameters. Use body only for non-GET methods when truly needed.'

export async function generateRestCall(args: {
  question: string
  endpoints: RestEndpointOption[]
  memoryContext?: string
}): Promise<RestCallPlan> {
  const raw = await chatOnce(
    [
      {
        role: 'system',
        content: REST_ROUTER_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content:
          `User question: ${args.question}\n\n` +
          (args.memoryContext ? `Memory: a similar previous request:\n${args.memoryContext}\n\n` : '') +
          `Whitelisted endpoints:\n${args.endpoints
            .map(
              (endpoint) =>
                `- id=${endpoint.id}; connector=${endpoint.connectorName}; method=${endpoint.method}; path=${endpoint.path}; description=${endpoint.description ?? '-'}; parameterSchema=${endpoint.parameterSchema ?? '-'}; sampleResponse=${endpoint.sampleResponse ?? '-'}`,
            )
            .join('\n')}\n\n` +
          'Provide the JSON endpoint selection.',
      },
    ],
    { purpose: 'rest' },
  )
  return parseRestCallJson(raw)
}

export function parseRestCallJson(raw: string): RestCallPlan {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  const parsed = JSON.parse(cleaned) as Partial<RestCallPlan>
  const query =
    parsed.query && typeof parsed.query === 'object' && !Array.isArray(parsed.query)
      ? parsed.query
      : {}
  return {
    endpointId: String(parsed.endpointId ?? '').trim(),
    query: query as RestCallPlan['query'],
    body: parsed.body === undefined ? null : parsed.body,
    explanation: String(parsed.explanation ?? '').trim(),
  }
}

/** Streaming answer — yields token chunks. */
export async function* streamAnswer(args: {
  question: string
  context: string
  source: 'SQL' | 'RAG' | 'REST_API' | 'CHAT'
  memoryContext?: string
  systemPromptPrefix?: string
  chatHistory?: ChatMessage[]
  /** SQL/REST row count — enables honest empty-result and truncation reporting. */
  rowCount?: number
  /** True when the result was cut off by the LIMIT clamp (resultLimit reached). */
  truncated?: boolean
}): AsyncGenerator<string, void, unknown> {
  const messages: ChatMessage[] = []
  if (args.systemPromptPrefix) {
    messages.push({ role: 'system', content: args.systemPromptPrefix })
  }
  if (args.memoryContext) {
    messages.push({ role: 'system', content: `Memory context from prior interactions:\n${args.memoryContext}` })
  }
  if (args.chatHistory && args.chatHistory.length > 0) {
    messages.push(...historyToMessages(args.chatHistory))
  }
  // ponytail: keep in sync with generateAnswer's empty/truncation notes.
  const emptyNote =
    args.rowCount === 0
      ? `The query executed successfully but returned 0 rows. State plainly that no matching data was found for this question. Do NOT invent rows, do NOT fabricate an explanation for why it is empty — if the reason is not evident from the data, say the filter may be too narrow and suggest what the user could relax (date range, status filter, entity name). `
      : ''
  const truncatedNote =
    args.truncated
      ? `The result was TRUNCATED to the first ${args.rowCount} rows by the system row limit. Tell the user explicitly (e.g. "showing the first ${args.rowCount} matching rows") — never present a truncated set as the complete answer, and offer to narrow the question for a complete view. `
      : ''
  messages.push(
    {
      role: 'system',
      content:
        'You are ryasai, an enterprise AI assistant. ' +
        'Answer the user\'s question based on the CONTEXT provided. ' +
        'If the question refers to prior data or conversation, use both the CONTEXT and the conversation history to answer. ' +
        'Do not say data is unavailable if it appears in the context or history. ' +
        emptyNote +
        truncatedNote +
        'If the CONTEXT marks a step FAILED, report that failure and its reason. ' +
        'Never invent data, and never substitute manual setup instructions for the user to run by hand. ' +
        'Format numbers for readability.',
    },
    {
      role: 'user',
      content: `Question: ${args.question}\n\nCONTEXT (${answerContextLabel(args.source)}):\n${args.context}\n\nAnswer:`,
    },
  )
  yield* chatStream(messages, { purpose: 'synthesis' })
}

export async function* streamChat(
  question: string,
  memoryContext?: string,
  systemPromptPrefix?: string,
  chatHistory?: ChatMessage[],
): AsyncGenerator<string, void, unknown> {
  const messages: ChatMessage[] = []
  if (systemPromptPrefix) {
    messages.push({ role: 'system', content: systemPromptPrefix })
  }
  if (memoryContext) {
    messages.push({ role: 'system', content: `Memory context from prior interactions:\n${memoryContext}` })
  }
  if (chatHistory && chatHistory.length > 0) {
    messages.push(...historyToMessages(chatHistory))
  }
  messages.push(
    {
      role: 'system',
      content:
        'You are ryasai, an enterprise AI assistant. ' +
        'You can help with: database queries (SQL), document search (RAG), REST API calls, and general chat. ' +
        'When the user refers to prior conversation or data, use the conversation history to answer without needing a new query. ' +
        'If the user provides new information, acknowledge and remember it. ' +
        'Do not say data is unavailable if it was discussed in prior conversation history.',
    },
    { role: 'user', content: question },
  )
  yield* chatStream(messages, { purpose: 'chat' })
}

/**
 * ponytail: history used to be flattened into ONE system message
 * ("Prior conversation history:\nUser: ... Assistant: ..."), which the model
 * reads as reference material, not as the live conversation — weaker
 * grounding for follow-ups ("itu", "yang tadi"). Native alternating
 * user/assistant turns keep the model's dialogue attention on the thread.
 * A short system note still labels the block so the model knows these are
 * prior turns, not the current question.
 */
export function historyToMessages(history: ChatMessage[]): ChatMessage[] {
  const recent = history.slice(-10)
  const out: ChatMessage[] = [
    { role: 'system', content: `Prior conversation history (most recent last):\n${formatHistory(recent)}` },
  ]
  for (const m of recent) {
    if (!m.content || !m.content.trim()) continue
    out.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content.slice(0, 2000),
    })
  }
  return out
}

function formatHistory(history: ChatMessage[]): string {
  const recent = history.slice(-10)
  return recent
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`)
    .join('\n')
}
