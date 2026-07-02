/**
 * AI Client — wraps z-ai-web-dev-sdk (sandbox default) OR a tenant-configured
 * OpenAI-compatible endpoint (when an admin sets one via /api/llm-config).
 * ----------------------------------------------------------------------------
 * Server-only. Mirrors spec §7 (`app/ai/agent.py`) — temperature=0 for
 * deterministic Text-to-SQL.
 *
 * Backend selection (resolveBackend):
 *   - If the caller passes a companyId AND a LlmConfig exists for that tenant,
 *     route completions to `${baseUrl}/chat/completions` with that key+model.
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
  companyId?: string
  temperature?: number
}

type Backend =
  | { mode: 'custom'; cfg: LlmRuntimeConfig }
  | { mode: 'zai'; ai: Awaited<ReturnType<typeof ZAI.create>> }

async function resolveBackend(companyId?: string): Promise<Backend> {
  if (companyId) {
    const cfg = await getLlmRuntimeConfig(companyId)
    if (cfg && cfg.baseUrl && cfg.apiKey) return { mode: 'custom', cfg }
  }
  return { mode: 'zai', ai: await getAI() }
}

/** Non-streaming completion. Returns the trimmed message content. */
async function chatOnce(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const backend = await resolveBackend(opts.companyId)
  const temperature = opts.temperature ?? 0

  if (backend.mode === 'custom') {
    const res = await fetch(`${backend.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${backend.cfg.apiKey}`,
      },
      body: JSON.stringify({ model: backend.cfg.model, messages, temperature }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) {
      throw new Error(`LLM error (HTTP ${res.status}).`)
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return (data.choices?.[0]?.message?.content ?? '').trim()
  }

  // z-ai SDK (sandbox default).
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
  const backend = await resolveBackend(opts.companyId)
  const temperature = opts.temperature ?? 0

  if (backend.mode === 'custom') {
    const res = await fetch(`${backend.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${backend.cfg.apiKey}`,
      },
      body: JSON.stringify({ model: backend.cfg.model, messages, temperature, stream: true }),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok || !res.body) {
      throw new Error(`LLM stream error (HTTP ${res.status}).`)
    }
    for await (const chunk of iterSseStream(res.body as unknown as ReadableStream<Uint8Array>)) {
      const token = (chunk.choices as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content
      if (token) yield token
    }
    return
  }

  const stream = await backend.ai.chat.completions.create({
    messages,
    thinking: { type: 'disabled' },
    stream: true,
  } as Parameters<typeof backend.ai.chat.completions.create>[0])
  for await (const chunk of iterSseStream(stream as unknown as ReadableStream<Uint8Array>)) {
    const token = (chunk.choices as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content
    if (token) yield token
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type RouteDecision = 'SQL' | 'RAG' | 'REST' | 'CHAT'

export interface RoutingContext {
  question: string
  hasIntegrations: boolean
  hasDocuments: boolean
  hasRestApis?: boolean
  companyId?: string
  smartMappingHints?: string
}

/**
 * LLM router. Decides which pipeline to run.
 * Uses deterministic prompting (temp=0) per spec §7.
 */
export async function routeQuery(ctx: RoutingContext): Promise<{
  decision: RouteDecision
  reason: string
}> {
  const decisionRaw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'Anda adalah router AI enterprise. Tentukan JALUR penanganan untuk pertanyaan user. ' +
          'Jawab HANYA dengan satu kata: SQL, RAG, REST, atau CHAT.\n' +
          '- SQL: pertanyaan tentang data terstruktur (stok, penjualan, pelanggan, invoice, angka, total, daftar dari database).\n' +
          '- RAG: pertanyaan tentang kebijakan, SOP, dokumen, prosedur, panduan, regulasi, atau teks non-struktural.\n' +
          '- REST: pertanyaan yang perlu memanggil endpoint REST API whitelisted pada sistem eksternal seperti CRM, tiket, HRIS, inventory service, atau aplikasi operasional lain.\n' +
          '- CHAT: sapaan, basa-basi, atau pertanyaan umum tanpa butuh data internal.',
      },
      {
        role: 'user',
        content:
          `Pertanyaan: "${ctx.question}"\n` +
          `Konteks: integrasi database tersedia=${ctx.hasIntegrations}, dokumen knowledge base tersedia=${ctx.hasDocuments}, REST API tersedia=${ctx.hasRestApis ?? false}.\n` +
          `Smart mapping aktif:\n${ctx.smartMappingHints || '-'}\n` +
          `Jawab hanya SQL / RAG / REST / CHAT.`,
      },
    ],
    { companyId: ctx.companyId },
  )
  const raw = decisionRaw.toUpperCase()
  const decision: RouteDecision = raw.startsWith('SQL')
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
  companyId?: string
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
          `Berikan JSON {"sql": "...", "explanation": "..."}.`,
      },
    ],
    { companyId: args.companyId },
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
  source: 'SQL' | 'RAG' | 'REST_API'
  provider?: string
  companyId?: string
}): Promise<string> {
  const sourceLabel = answerContextLabel(args.source)
  return chatOnce(
    [
      {
        role: 'system',
        content:
          `Anda adalah ryasai, asisten AI perusahaan. ` +
          `Jawab pertanyaan user berdasarkan KONTEKS yang diberikan. ` +
          `Jika konteks tidak cukup, nyatakan dengan jelas. ` +
          `Sajikan jawaban dalam Bahasa Indonesia yang jelas, ringkas, dan profesional. ` +
          `Jika data berupa angka, tampilkan dalam format yang mudah dibaca. ` +
          `Sebutkan sumber data secara natural di akhir jawaban.`,
      },
      {
        role: 'user',
        content:
          `Pertanyaan: ${args.question}\n\n` +
          `KONTEKS (${sourceLabel}):\n${args.context}\n\n` +
          `Jawab:`,
      },
    ],
    { companyId: args.companyId },
  )
}

export function answerContextLabel(source: 'SQL' | 'RAG' | 'REST_API'): string {
  return source === 'REST_API' ? 'REST API' : source
}

/** Pure non-streaming chat (no SQL/RAG) for external API and general questions. */
export async function generateChat(
  question: string,
  companyId?: string,
): Promise<string> {
  return chatOnce(
    [
      {
        role: 'system',
        content:
          'Anda adalah ryasai, asisten AI perusahaan yang ramah, profesional, dan menjawab dalam Bahasa Indonesia.',
      },
      { role: 'user', content: question },
    ],
    { companyId },
  )
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
  companyId?: string
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
          `Endpoint whitelisted:\n${args.endpoints
            .map(
              (endpoint) =>
                `- id=${endpoint.id}; connector=${endpoint.connectorName}; method=${endpoint.method}; path=${endpoint.path}; description=${endpoint.description ?? '-'}; parameterSchema=${endpoint.parameterSchema ?? '-'}; sampleResponse=${endpoint.sampleResponse ?? '-'}`,
            )
            .join('\n')}\n\n` +
          'Berikan JSON pilihan endpoint.',
      },
    ],
    { companyId: args.companyId },
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

/**
 * Parse a Server-Sent-Events byte stream into parsed JSON payloads.
 * Handles both the z-ai SDK raw body and standard OpenAI-compatible SSE.
 */
async function* iterSseStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<unknown>,
): AsyncGenerator<Record<string, unknown>> {
  if (
    typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function' &&
    !(stream instanceof ReadableStream)
  ) {
    for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
      if (chunk && typeof chunk === 'object') yield chunk
    }
    return
  }
  const reader = (stream as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nlIdx: number
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).trim()
        buffer = buffer.slice(nlIdx + 1)
        if (!line || !line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data)
        } catch {
          /* partial JSON or keep-alive comment — skip */
        }
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim()
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data)
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
}

/** Streaming answer — yields token chunks. */
export async function* streamAnswer(args: {
  question: string
  context: string
  source: 'SQL' | 'RAG'
  companyId?: string
}): AsyncGenerator<string, void, unknown> {
  yield* chatStream(
    [
      {
        role: 'system',
        content:
          'Anda adalah ryasai, asisten AI perusahaan. ' +
          'Jawab pertanyaan user berdasarkan KONTEKS yang diberikan. ' +
          'Sajikan dalam Bahasa Indonesia yang jelas dan profesional. ' +
          'Jika data berupa angka, format agar mudah dibaca.',
      },
      {
        role: 'user',
        content: `Pertanyaan: ${args.question}\n\nKONTEKS (${args.source}):\n${args.context}\n\nJawab:`,
      },
    ],
    { companyId: args.companyId },
  )
}

/** Pure chat (no SQL/RAG) for greetings & general questions. */
export async function* streamChat(
  question: string,
  companyId?: string,
): AsyncGenerator<string, void, unknown> {
  yield* chatStream(
    [
      { role: 'system', content: 'Anda adalah ryasai, asisten AI perusahaan yang ramah, profesional, dan menjawab dalam Bahasa Indonesia.' },
      { role: 'user', content: question },
    ],
    { companyId },
  )
}
