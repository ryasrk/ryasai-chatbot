/**
 * AI Client — wraps z-ai-web-dev-sdk for the Enterprise Assistant.
 * ----------------------------------------------------------------------------
 * Server-only. Mirrors spec §7 (`app/ai/agent.py`) — a single configured LLM
 * entrypoint with temperature=0 for deterministic Text-to-SQL.
 *
 * Responsibilities:
 *   - routeQuery(): decide whether a user question needs SQL, RAG, or chit-chat.
 *   - generateSql(): Text-to-SQL given a reflected schema + question.
 *   - generateAnswer(): final NL answer from SQL rows / RAG context.
 *   - streamAnswer(): token-by-token streaming for the WebSocket service.
 */
import ZAI from 'z-ai-web-dev-sdk'

let _zai: Awaited<ReturnType<typeof ZAI.create>> | null = null

export async function getAI() {
  if (!_zai) {
    _zai = await ZAI.create()
  }
  return _zai
}

export type RouteDecision = 'SQL' | 'RAG' | 'CHAT'

export interface RoutingContext {
  question: string
  hasIntegrations: boolean
  hasDocuments: boolean
}

/**
 * LLM router. Decides which pipeline to run.
 * Uses deterministic prompting (temp=0) per spec §7.
 */
export async function routeQuery(ctx: RoutingContext): Promise<{
  decision: RouteDecision
  reason: string
}> {
  const ai = await getAI()
  const completion = await ai.chat.completions.create({
    messages: [
      {
        role: 'assistant',
        content:
          'Anda adalah router AI enterprise. Tentukan JALUR penanganan untuk pertanyaan user. ' +
          'Jawab HANYA dengan satu kata: SQL, RAG, atau CHAT.\n' +
          '- SQL: pertanyaan tentang data terstruktur (stok, penjualan, pelanggan, invoice, angka, total, daftar dari database).\n' +
          '- RAG: pertanyaan tentang kebijakan, SOP, dokumen, prosedur, panduan, regulasi, atau teks non-struktural.\n' +
          '- CHAT: sapaan, basa-basi, atau pertanyaan umum tanpa butuh data internal.',
      },
      {
        role: 'user',
        content:
          `Pertanyaan: "${ctx.question}"\n` +
          `Konteks: integrasi database tersedia=${ctx.hasIntegrations}, dokumen knowledge base tersedia=${ctx.hasDocuments}.\n` +
          `Jawab hanya SQL / RAG / CHAT.`,
      },
    ],
    thinking: { type: 'disabled' },
  })
  const raw = (completion.choices[0]?.message?.content ?? 'CHAT').trim().toUpperCase()
  const decision: RouteDecision = raw.startsWith('SQL') ? 'SQL' : raw.startsWith('RAG') ? 'RAG' : 'CHAT'
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
}): Promise<{ sql: string; explanation: string }> {
  const ai = await getAI()
  const completion = await ai.chat.completions.create({
    messages: [
      {
        role: 'assistant',
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
    thinking: { type: 'disabled' },
  })
  const raw = completion.choices[0]?.message?.content ?? ''
  return parseSqlJson(raw)
}

function parseSqlJson(raw: string): { sql: string; explanation: string } {
  // strip code fences if present
  const cleaned = raw.replace(/```json|```/g, '').trim()
  try {
    const obj = JSON.parse(cleaned)
    return { sql: String(obj.sql ?? '').trim(), explanation: String(obj.explanation ?? '').trim() }
  } catch {
    // fallback: assume raw is the SQL
    return { sql: cleaned, explanation: 'Kueri dihasilkan oleh LLM.' }
  }
}

/**
 * Generate the final natural-language answer from SQL rows / RAG context.
 * Used by both the HTTP fallback and the WebSocket streaming service.
 */
export async function generateAnswer(args: {
  question: string
  context: string // SQL result rows (as text/JSON) OR retrieved document chunks
  source: 'SQL' | 'RAG'
  provider?: string
}): Promise<string> {
  const ai = await getAI()
  const completion = await ai.chat.completions.create({
    messages: [
      {
        role: 'assistant',
        content:
          `Anda adalah AI Internal Assistant perusahaan. ` +
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
          `KONTEKS (${args.source}):\n${args.context}\n\n` +
          `Jawab:`,
      },
    ],
    thinking: { type: 'disabled' },
  })
  return (completion.choices[0]?.message?.content ?? '').trim()
}

/**
 * Parse a Server-Sent-Events byte stream (as returned by z-ai-web-dev-sdk
 * when `stream: true`) into parsed JSON payloads.
 *
 * The SDK returns the raw `response.body` ReadableStream — NOT an async
 * iterable of parsed chunks. We must decode + split SSE frames ourselves.
 * Handles partial frames split across byte chunks.
 */
async function* iterSseStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<unknown>,
): AsyncGenerator<Record<string, unknown>> {
  // If the SDK ever starts returning a real async iterable, pass through.
  if (typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function' &&
      !(stream instanceof ReadableStream)) {
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
    // flush any trailing buffered line
    const tail = buffer.trim()
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim()
      if (data && data !== '[DONE]') {
        try { yield JSON.parse(data) } catch { /* ignore */ }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* ignore */ }
  }
}

/**
 * Streaming answer — yields token chunks.
 * Used by the socket.io mini-service for the `text_stream` event (spec §5.2).
 */
export async function* streamAnswer(args: {
  question: string
  context: string
  source: 'SQL' | 'RAG'
}): AsyncGenerator<string, void, unknown> {
  const ai = await getAI()
  const stream = await ai.chat.completions.create({
    messages: [
      {
        role: 'assistant',
        content:
          'Anda adalah AI Internal Assistant perusahaan. ' +
          'Jawab pertanyaan user berdasarkan KONTEKS yang diberikan. ' +
          'Sajikan dalam Bahasa Indonesia yang jelas dan profesional. ' +
          'Jika data berupa angka, format agar mudah dibaca.',
      },
      {
        role: 'user',
        content: `Pertanyaan: ${args.question}\n\nKONTEKS (${args.source}):\n${args.context}\n\nJawab:`,
      },
    ],
    thinking: { type: 'disabled' },
    stream: true,
  })

  for await (const chunk of iterSseStream(stream as unknown as ReadableStream<Uint8Array>)) {
    const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined
    const token = choices?.[0]?.delta?.content
    if (token) yield token
  }
}

/** Pure chat (no SQL/RAG) for greetings & general questions. */
export async function* streamChat(question: string): AsyncGenerator<string, void, unknown> {
  const ai = await getAI()
  const stream = await ai.chat.completions.create({
    messages: [
      { role: 'assistant', content: 'Anda adalah AI Internal Assistant perusahaan yang ramah, profesional, dan menjawab dalam Bahasa Indonesia.' },
      { role: 'user', content: question },
    ],
    thinking: { type: 'disabled' },
    stream: true,
  })

  for await (const chunk of iterSseStream(stream as unknown as ReadableStream<Uint8Array>)) {
    const choices = chunk.choices as Array<{ delta?: { content?: string } }> | undefined
    const token = choices?.[0]?.delta?.content
    if (token) yield token
  }
}
