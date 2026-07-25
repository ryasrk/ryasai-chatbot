/**
 * AI Client — wraps z-ai-web-dev-sdk (sandbox default) OR a configured
 * OpenAI-compatible endpoint (when an admin sets one via /api/llm-config).
 * ----------------------------------------------------------------------------
 * Server-only. Mirrors spec §7 (`app/ai/agent.py`) — temperature=0 for
 * deterministic Text-to-SQL.
 *
 * Backend selection (resolveBackend):
 *   - If a LlmConfig exists, route completions to `${baseUrl}/chat/completions`
 *     with that key+model.
 *   - Otherwise fall back to the z-ai-web-dev-sdk (sandbox default).
 *
 * Responsibilities:
 *   - routeQuery(): decide whether a user question needs SQL, RAG, or chit-chat.
 *   - generateSql(): Text-to-SQL given a reflected schema + question.
 *   - generateAnswer(): final NL answer from SQL rows / RAG context.
 *   - streamAnswer(): token-by-token streaming for the WebSocket service.
 */
import ZAI from 'z-ai-web-dev-sdk'
import { getLlmRuntimeConfig, type LlmRuntimeConfig } from '@/lib/llm-config'
import { chatOnce as llmChatOnce, chatStream as llmChatStream } from '@/lib/llm-client'

let _zai: Awaited<ReturnType<typeof ZAI.create>> | null = null

export async function getAI() {
  if (!_zai) {
    _zai = await ZAI.create()
  }
  return _zai
}

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
}

type Backend =
  | { mode: 'custom'; cfg: LlmRuntimeConfig }
  | { mode: 'zai'; ai: Awaited<ReturnType<typeof ZAI.create>> }

async function resolveBackend(): Promise<Backend> {
  const cfg = await getLlmRuntimeConfig()
  if (cfg && cfg.baseUrl && cfg.apiKey) return { mode: 'custom', cfg }
  return { mode: 'zai', ai: await getAI() }
}

/** Non-streaming completion. Returns the trimmed message content. */
async function chatOnce(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const backend = await resolveBackend()
  const temperature = opts.temperature ?? 0

  if (backend.mode === 'custom') {
    return llmChatOnce(backend.cfg, messages, temperature)
  }

  const completion = await backend.ai.chat.completions.create({
    messages,
    thinking: { type: 'disabled' },
  } as Parameters<typeof backend.ai.chat.completions.create>[0])
  return (completion.choices[0]?.message?.content ?? '').trim()
}

/** Streaming completion — yields token chunks. */
async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOpts = {},
): AsyncGenerator<string, void, unknown> {
  const backend = await resolveBackend()
  const temperature = opts.temperature ?? 0

  if (backend.mode === 'custom') {
    yield* llmChatStream(backend.cfg, messages, temperature)
    return
  }

  const stream = await backend.ai.chat.completions.create({
    messages,
    thinking: { type: 'disabled' },
    stream: true,
  } as Parameters<typeof backend.ai.chat.completions.create>[0])
  for await (const chunk of stream as unknown as AsyncIterable<{ choices?: Array<{ delta?: { content?: string } }> }>) {
    const token = chunk.choices?.[0]?.delta?.content
    if (token) yield token
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RouteDecision = 'SQL' | 'RAG' | 'REST' | 'CHAT' | 'CONTEXTUAL_CHAT'

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
        .map((m) => `${m.role === 'user' ? 'User' : 'Asisten'}: ${m.content.slice(0, 400)}`)
        .join('\n')
    : ''

  const decisionRaw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'Anda adalah router AI enterprise. Tentukan JALUR penanganan untuk pesan user. ' +
          'Jawab HANYA dengan satu kata: SQL, RAG, REST, CHAT, atau CONTEXTUAL_CHAT.\n' +
          '- SQL: pertanyaan tentang data terstruktur (stok, penjualan, pelanggan, invoice, angka, total, daftar dari database).\n' +
          '- RAG: pertanyaan tentang kebijakan, SOP, dokumen, prosedur, panduan, regulasi, atau teks non-struktural.\n' +
          '- REST: pertanyaan yang perlu memanggil endpoint REST API whitelisted pada sistem eksternal.\n' +
          '- CHAT: sapaan, basa-basi, atau pertanyaan umum tanpa butuh data internal.\n' +
          '- CONTEXTUAL_CHAT: user merujuk ke percakapan sebelumnya ATAU memberikan informasi/fakta baru.\n' +
          '  Contoh CONTEXTUAL_CHAT:\n' +
          '  - "sebutkan lagi jawabanmu" → CONTEXTUAL_CHAT (bukan SQL)\n' +
          '  - "produk apa yang saya tanyakan tadi?" → CONTEXTUAL_CHAT (bukan SQL)\n' +
          '  - "berapa harganya?" (tanpa sebut produk) → CONTEXTUAL_CHAT (bukan SQL, karena "harganya" = harga dari produk yang dibahas sebelumnya)\n' +
          '  - "produk terlaris adalah SKU-902 dengan 5800 unit" → CONTEXTUAL_CHAT (bukan SQL, karena user memberi tahu fakta, bukan bertanya)\n' +
          '  - "saya mau bilang bahwa..." → CONTEXTUAL_CHAT\n' +
          '  Contoh SQL/RAG (bukan CONTEXTUAL_CHAT):\n' +
          '  - "berapa stok SKU-902?" → SQL (sebut produk spesifik + minta data)\n' +
          '  - "apa prosedur stock opname?" → RAG (tanya dokumen)\n' +
          '  ATURAN PENTING: jika pesan TIDAK diakhiri tanda tanya DAN mengandung kata "adalah/yaitu/ialah/merupakan", kemungkinan besar itu adalah statement → CONTEXTUAL_CHAT.',
      },
      {
        role: 'user',
        content:
          `Pertanyaan: "${ctx.question}"\n` +
          `Konteks: integrasi database tersedia=${ctx.hasIntegrations}, dokumen knowledge base tersedia=${ctx.hasDocuments}, REST API tersedia=${ctx.hasRestApis ?? false}.\n` +
          (ctx.memoryContext ? `Memori interaksi sebelumnya:\n${ctx.memoryContext}\n` : '') +
          (hasHistory ? `Riwayat percakapan sebelumnya:\n${historyText}\n` : '') +
          `Jawab hanya SQL / RAG / REST / CHAT / CONTEXTUAL_CHAT.`,
      },
    ],
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
  return { decision, reason: `Router LLM memilih ${decision}` }
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
}): Promise<{ sql: string; explanation: string }> {
  const raw = await chatOnce(
    [
      {
        role: 'system',
        content:
          `Anda adalah ahli ${args.provider} Text-to-SQL. ` +
          'Tugas: ubah pertanyaan natural menjadi SATU kueri SELECT yang valid & efisien. ' +
          'ATURAN:\n' +
          '1. HANYA boleh SELECT. DILARANG INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE.\n' +
          '2. Selalu sertakan LIMIT jika relevan (maksimal 100 baris).\n' +
          '3. Gunakan hanya tabel & kolom yang ada di skema berikut.\n' +
          '4. Format jawaban sebagai JSON: {"sql": "...", "explanation": "..."}.\n' +
          '5. Jangan bungkus dengan markdown code fence.',
      },
      {
        role: 'user',
        content:
          `Dialek: ${args.provider}\n` +
          `Skema database:\n${args.schemaDescription}\n\n` +
          `Pertanyaan user: ${args.question}\n\n` +
          (args.memoryContext ? `Memori: query serupa sebelumnya berhasil dengan:\n${args.memoryContext}\n\n` : '') +
          `Berikan JSON {"sql": "...", "explanation": "..."}.`,
      },
    ],
  )
  return parseSqlJson(raw)
}

function parseSqlJson(raw: string): { sql: string; explanation: string } {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  try {
    const obj = JSON.parse(cleaned)
    return { sql: String(obj.sql ?? '').trim(), explanation: String(obj.explanation ?? '').trim() }
  } catch {
    return { sql: cleaned, explanation: 'Kueri dihasilkan oleh LLM.' }
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
    messages.push({ role: 'system', content: `Prior conversation history:\n${formatHistory(args.chatHistory)}` })
  }
  messages.push({
    role: 'system',
    content:
      `You are ryasai, an enterprise AI assistant. ` +
      `Answer the user's question based on the CONTEXT provided. ` +
      `If the question refers to prior data or conversation, use both the CONTEXT and the conversation history to answer. ` +
      `Do not say data is unavailable if it appears in the context or history. ` +
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
  return chatOnce(messages)
}

export function answerContextLabel(source: 'SQL' | 'RAG' | 'REST_API' | 'CHAT'): string {
  if (source === 'REST_API') return 'REST API'
  if (source === 'CHAT') return 'PRIOR CONTEXT'
  return source
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
    messages.push({ role: 'system', content: `Prior conversation history:\n${formatHistory(chatHistory)}` })
  }
  messages.push({ role: 'user', content: question })
  return chatOnce(messages)
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
  'Anda adalah router REST API enterprise. Pilih SATU endpoint whitelisted paling relevan untuk menjawab pertanyaan user. ' +
  'Jangan membuat path baru. Gunakan endpointId persis dari daftar. ' +
  'sampleResponse hanya contoh struktur, bukan data final untuk menjawab user. ' +
  'Explanation cukup jelaskan alasan memilih endpoint dan parameter yang dikirim. ' +
  'Jangan kirim query atau body jika parameterSchema kosong atau tidak menyebut parameter itu. ' +
  'Jawab HANYA JSON tanpa markdown: {"endpointId":"...","query":{},"body":null,"explanation":"..."}.\n' +
  'Gunakan query untuk parameter URL sederhana. Gunakan body hanya untuk method non-GET jika memang diperlukan.'

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
          `Pertanyaan user: ${args.question}\n\n` +
          (args.memoryContext ? `Memori: request serupa sebelumnya:\n${args.memoryContext}\n\n` : '') +
          `Endpoint whitelisted:\n${args.endpoints
            .map(
              (endpoint) =>
                `- id=${endpoint.id}; connector=${endpoint.connectorName}; method=${endpoint.method}; path=${endpoint.path}; description=${endpoint.description ?? '-'}; parameterSchema=${endpoint.parameterSchema ?? '-'}; sampleResponse=${endpoint.sampleResponse ?? '-'}`,
            )
            .join('\n')}\n\n` +
          'Berikan JSON pilihan endpoint.',
      },
    ],
  )
  return parseRestCallJson(raw)
}

function parseRestCallJson(raw: string): RestCallPlan {
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
}): AsyncGenerator<string, void, unknown> {
  const messages: ChatMessage[] = []
  if (args.systemPromptPrefix) {
    messages.push({ role: 'system', content: args.systemPromptPrefix })
  }
  if (args.memoryContext) {
    messages.push({ role: 'system', content: `Memory context from prior interactions:\n${args.memoryContext}` })
  }
  if (args.chatHistory && args.chatHistory.length > 0) {
    messages.push({ role: 'system', content: `Prior conversation history:\n${formatHistory(args.chatHistory)}` })
  }
  messages.push(
    {
      role: 'system',
      content:
        'You are ryasai, an enterprise AI assistant. ' +
        'Answer the user\'s question based on the CONTEXT provided. ' +
        'If the question refers to prior data or conversation, use both the CONTEXT and the conversation history to answer. ' +
        'Do not say data is unavailable if it appears in the context or history. ' +
        'Format numbers for readability.',
    },
    {
      role: 'user',
      content: `Question: ${args.question}\n\nCONTEXT (${answerContextLabel(args.source)}):\n${args.context}\n\nAnswer:`,
    },
  )
  yield* chatStream(messages)
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
    messages.push({ role: 'system', content: `Prior conversation history:\n${formatHistory(chatHistory)}` })
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
  yield* chatStream(messages)
}

function formatHistory(history: ChatMessage[]): string {
  const recent = history.slice(-10)
  return recent
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`)
    .join('\n')
}
