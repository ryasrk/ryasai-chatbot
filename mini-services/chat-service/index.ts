/**
 * chat-service — WebSocket streaming chat mini-service (spec §5.2)
 * ===========================================================================
 * Independent Bun process listening on port 3003 with socket.io path '/'.
 * Caddy forwards `?XTransformPort=3003` to this port.
 *
 * Event protocol (spec §5.2):
 *   Client → Server:  `user_message` { text, sessionId, userId, companyId, integrationId? }
 *   Server → Client:  `status_update` { status, message }
 *                      status ∈ routing | executing_sql | rag_retrieving | generating | complete | error
 *   Server → Client:  `text_stream` { token }
 *   Server → Client:  `message_complete` { text_final, citations, chartData? }
 *
 * Pipeline per user_message:
 *   routing → (SQL | RAG | CHAT) → stream tokens → persist AI message → complete
 *
 * This module imports parent libs via RELATIVE paths (the mini-service is a
 * separate process, so it gets its own PrismaClient connection — that's fine).
 */
import { createServer } from 'http'
import { Server, type Socket } from 'socket.io'
import { db } from '../../src/lib/db'
import { serverConfig } from '../../src/lib/config'
import { routeQuery, generateSql, streamAnswer, streamChat } from '../../src/lib/ai'
import { validateAndSanitizeLlmSql } from '../../src/lib/guardrails'
import { decryptConfig } from '../../src/lib/crypto'
import {
  connectorRegistry,
  describeSchema,
  ensureDemoSchema,
  type ReflectedTable,
  type QueryRow,
} from '../../src/lib/connectors'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserMessagePayload {
  text: string
  sessionId: string
  userId: string
  companyId: string
  integrationId?: string
}

interface Citation {
  type: 'DATABASE' | 'DOCUMENT'
  source: string
  query_used: string
}

interface ChartData {
  type: 'bar' | 'line'
  data: QueryRow[]
  xKey: string
  yKeys: string[]
}

type StatusEvent = (status: string, message: string) => void
type TokenEvent = (token: string) => void
type CompleteEvent = (textFinal: string, citations: Citation[], chartData?: ChartData | null) => void

const PORT = serverConfig.wsPort

/**
 * Verify a client-supplied identity against the database before processing.
 * The socket protocol previously trusted userId/companyId/sessionId verbatim,
 * which allowed any client to drive chat as any user/tenant. We now confirm the
 * user is active, belongs to the claimed company, and owns the session.
 */
async function resolveIdentity(args: {
  userId: string
  companyId: string
  sessionId: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [user, session] = await Promise.all([
    db.user.findUnique({
      where: { id: args.userId },
      select: { id: true, companyId: true, isActive: true },
    }),
    db.chatSession.findUnique({
      where: { id: args.sessionId },
      select: { id: true, companyId: true, userId: true },
    }),
  ])
  if (!user || !user.isActive) return { ok: false, reason: 'Identitas pengguna tidak valid.' }
  if (user.companyId !== args.companyId) return { ok: false, reason: 'Tenant tidak cocok.' }
  if (!session) return { ok: false, reason: 'Sesi tidak ditemukan.' }
  if (session.companyId !== args.companyId || session.userId !== args.userId) {
    return { ok: false, reason: 'Sesi bukan milik pengguna ini.' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Keyword utilities (used by RAG scoring)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set<string>([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'ini', 'itu',
  'atau', 'akan', 'adalah', 'kami', 'anda', 'saya', 'mereka', 'kita', 'para',
  'juga', 'oleh', 'agar', 'tentang', 'sebagai', 'setelah', 'sebelum', 'selama',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'what', 'how',
  'when', 'where', 'why', 'who', 'which', 'are', 'was', 'were', 'been', 'have',
  'has', 'had', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
  'tampilkan', 'tunjukkan', 'berikan', 'ingin', 'mau', 'lihat', 'semua',
  'setiap', 'apakah', 'berapa', 'jumlah', 'total', 'daftar', 'karena', 'namun',
])

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
}

// ---------------------------------------------------------------------------
// SQL / chart helpers
// ---------------------------------------------------------------------------

function safeParseColumns(raw: string): { name: string; type: string }[] {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.map((c: unknown) => {
        const obj = c as { name?: unknown; type?: unknown }
        return { name: String(obj.name ?? ''), type: String(obj.type ?? '') }
      })
    }
  } catch {
    /* ignore */
  }
  return []
}

function safeDecrypt(hex: string): Record<string, unknown> {
  try {
    return decryptConfig(hex)
  } catch {
    return {}
  }
}

function extractTableName(sql: string): string {
  const m = sql.match(/\b(?:FROM|JOIN)\s+["`]?(\w+)["`]?/i)
  return m ? m[1] : 'query'
}

function isNumeric(v: unknown): boolean {
  if (typeof v === 'number') return true
  if (typeof v === 'bigint') return true
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return true
  return false
}

function isDateString(v: unknown): boolean {
  if (typeof v !== 'string') return false
  return /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{2}\/\d{2}\/\d{4}/.test(v)
}

/**
 * Build a Recharts-compatible chart spec from SQL result rows.
 * Heuristic:
 *   - Need ≥2 rows and ≥2 columns.
 *   - First string/date column → xKey (label axis).
 *   - All numeric columns → yKeys (series).
 *   - If the xKey column looks like dates → 'line' chart, else 'bar'.
 * Returns null if no chartable structure exists.
 */
function buildChartData(rows: QueryRow[]): ChartData | null {
  if (!rows || rows.length < 2) return null
  const sampleKeys = Object.keys(rows[0] ?? {})
  if (sampleKeys.length < 2) return null

  let xKey: string | null = null
  const yKeys: string[] = []
  let looksLikeTimeSeries = false

  for (const k of sampleKeys) {
    const sampleVals = rows.slice(0, 6).map((r) => r[k])
    if (sampleVals.every(isNumeric)) {
      yKeys.push(k)
    } else if (!xKey && sampleVals.every((v) => typeof v === 'string' || typeof v === 'number')) {
      // Treat the first non-numeric column as the label axis.
      if (sampleVals.every((v) => typeof v === 'string')) {
        xKey = k
        if (sampleVals.some(isDateString)) looksLikeTimeSeries = true
      }
    }
  }

  if (!xKey || yKeys.length === 0) return null

  return {
    type: looksLikeTimeSeries ? 'line' : 'bar',
    data: rows,
    xKey,
    yKeys,
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistAiMessage(args: {
  sessionId: string
  userId: string
  text: string
  citations: Citation[]
  chartData: ChartData | null
  integrationId?: string
}): Promise<void> {
  try {
    await db.chatMessage.create({
      data: {
        sessionId: args.sessionId,
        userId: args.userId,
        sender: 'ai',
        text: args.text,
        status: 'complete',
        citations: JSON.stringify(args.citations),
        chartData: args.chartData ? JSON.stringify(args.chartData) : null,
        integrationId: args.integrationId ?? null,
      },
    })
    await db.chatSession
      .update({
        where: { id: args.sessionId },
        data: { updatedAt: new Date() },
      })
      .catch(() => {
        /* session might not exist if test fixture — ignore */
      })
  } catch (err) {
    console.error('[chat-service] persistAiMessage failed:', err)
  }
}

// ---------------------------------------------------------------------------
// Pipeline branches
// ---------------------------------------------------------------------------

async function runSqlBranch(
  text: string,
  sessionId: string,
  userId: string,
  companyId: string,
  integrationId: string | undefined,
  emitStatus: StatusEvent,
  emitToken: TokenEvent,
  emitComplete: CompleteEvent,
): Promise<void> {
  // Resolve integration: explicit id OR first active integration for the company.
  const integration = integrationId
    ? await db.integration.findFirst({ where: { id: integrationId, companyId } })
    : await db.integration.findFirst({
        where: { companyId, status: 'active' },
        orderBy: { createdAt: 'asc' },
      })

  if (!integration) {
    emitStatus('error', 'Tidak ada integrasi database aktif.')
    emitComplete(
      'Tidak ada sumber data database yang terhubung untuk perusahaan Anda. Hubungi admin untuk menambahkan integrasi.',
      [],
    )
    return
  }

  emitStatus('executing_sql', 'Membaca tabel inventory pada database ERP...')

  // Load cached schema rows for this integration.
  const schemaRows = await db.integrationSchema.findMany({
    where: { integrationId: integration.id },
  })

  let tables: ReflectedTable[] = schemaRows.map((r) => ({
    tableName: r.tableName,
    columns: safeParseColumns(r.columns),
    rowCount: r.rowCount ?? undefined,
  }))

  const decryptedConfig = safeDecrypt(integration.encryptedConfig)

  // If nothing cached, reflect on the fly via the connector.
  if (tables.length === 0) {
    await ensureDemoSchema()
    const connector = connectorRegistry.getConnector(
      integration.id,
      integration.provider,
      decryptedConfig,
    )
    tables = await connector.fetchSchema()
  }

  const schemaDescription = describeSchema(tables)
  const { sql: rawSql } = await generateSql({
    question: text,
    schemaDescription,
    provider: integration.provider,
    companyId,
  })

  // Guardrail — AST validate + sanitize.
  const guard = validateAndSanitizeLlmSql(rawSql)
  if (!guard.ok) {
    emitStatus('error', guard.reason ?? 'Kueri ditolak oleh guardrail keamanan.')
    try {
      await db.auditLog.create({
        data: {
          companyId,
          userId,
          action: 'GUARDRAIL_BLOCK',
          severity: 'critical',
          detail: JSON.stringify({
            reason: guard.reason,
            detectedNodes: guard.detectedNodes,
            naturalQuery: text,
            rawSql,
            integrationId: integration.id,
          }),
        },
      })
    } catch (e) {
      console.error('[chat-service] auditLog create failed (guardrail):', e)
    }
    emitComplete(
      'Pertanyaan Anda ditolak karena sistem mendeteksi aktivitas ilegal yang mencoba mengubah data perusahaan.',
      [],
    )
    return
  }

  const sanitizedSql = guard.sanitized

  // Execute via connector.
  const connector = connectorRegistry.getConnector(
    integration.id,
    integration.provider,
    decryptedConfig,
  )

  let result
  try {
    result = await connector.executeQuery(sanitizedSql)
  } catch (execErr) {
    console.error('[chat-service] SQL execute error:', execErr)
    try {
      await db.queryHistory.create({
        data: {
          integrationId: integration.id,
          userId,
          naturalQuery: text,
          generatedSql: sanitizedSql,
          success: false,
          errorMessage: String(execErr),
        },
      })
      await db.auditLog.create({
        data: {
          companyId,
          userId,
          action: 'SQL_EXECUTE',
          severity: 'warning',
          detail: JSON.stringify({
            error: String(execErr),
            sql: sanitizedSql,
            integrationId: integration.id,
          }),
        },
      })
    } catch (e) {
      console.error('[chat-service] persist failure on SQL exec error:', e)
    }
    emitStatus('error', 'Gagal menjalankan kueri pada database.')
    emitComplete(
      'Maaf, kueri ke database gagal dieksekusi. Silakan coba pertanyaan yang lebih spesifik.',
      [],
    )
    return
  }

  // Persist query history + audit log.
  try {
    await db.queryHistory.create({
      data: {
        integrationId: integration.id,
        userId,
        naturalQuery: text,
        generatedSql: sanitizedSql,
        rowCount: result.rowCount,
        executionMs: result.executionMs,
        success: true,
      },
    })
    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'SQL_EXECUTE',
        severity: 'info',
        detail: JSON.stringify({
          integrationId: integration.id,
          sql: sanitizedSql,
          rowCount: result.rowCount,
          executionMs: result.executionMs,
        }),
      },
    })
  } catch (e) {
    console.error('[chat-service] persist failure on SQL success:', e)
  }

  // Stream the natural-language answer.
  emitStatus('generating', 'Menyusun jawaban dari hasil kueri...')
  let textFinal = ''
  for await (const token of streamAnswer({
    question: text,
    context: JSON.stringify(result.rows, null, 2),
    source: 'SQL',
    companyId,
  })) {
    textFinal += token
    emitToken(token)
  }

  const tableName = extractTableName(sanitizedSql)
  const citations: Citation[] = [
    {
      type: 'DATABASE',
      source: `${integration.name}.${tableName}`,
      query_used: sanitizedSql,
    },
  ]
  const chartData = buildChartData(result.rows)

  await persistAiMessage({
    sessionId,
    userId,
    text: textFinal,
    citations,
    chartData,
    integrationId: integration.id,
  })

  emitStatus('complete', 'Selesai.')
  emitComplete(textFinal, citations, chartData)
}

async function runRagBranch(
  text: string,
  sessionId: string,
  userId: string,
  companyId: string,
  emitStatus: StatusEvent,
  emitToken: TokenEvent,
  emitComplete: CompleteEvent,
): Promise<void> {
  emitStatus('rag_retrieving', 'Mencari dokumen relevan di knowledge base...')

  const documents = await db.document.findMany({
    where: { companyId, status: 'ready' },
    include: { chunks: true },
  })

  const queryKeywords = extractKeywords(text)
  const qKwSet = new Set(queryKeywords)

  const scored = documents.flatMap((doc) =>
    doc.chunks.map((chunk) => {
      const chunkKeywords = extractKeywords(`${chunk.content} ${chunk.keywords ?? ''}`)
      const chunkKeywordSet = new Set(chunkKeywords)
      let score = 0
      for (const q of qKwSet) {
        if (chunkKeywordSet.has(q)) score += 2
        else if (chunk.content.toLowerCase().includes(q)) score += 1
      }
      return { doc, chunk, score }
    }),
  )

  scored.sort((a, b) => b.score - a.score)
  const topChunks = scored.slice(0, 4).filter((s) => s.score > 0)

  if (topChunks.length === 0) {
    // No relevant chunks — fall back to plain chat with a soft notice.
    emitStatus('generating', 'Menyusun jawaban...')
    let textFinal = ''
    for await (const token of streamChat(text, companyId)) {
      textFinal += token
      emitToken(token)
    }
    const citations: Citation[] = []
    await persistAiMessage({ sessionId, userId, text: textFinal, citations, chartData: null })
    emitStatus('complete', 'Selesai.')
    emitComplete(textFinal, citations, null)
    return
  }

  emitStatus('generating', 'Menyusun jawaban dari dokumen...')
  const contextText = topChunks.map((s) => s.chunk.content).join('\n\n---\n\n')
  let textFinal = ''
  for await (const token of streamAnswer({
    question: text,
    context: contextText,
    source: 'RAG',
    companyId,
  })) {
    textFinal += token
    emitToken(token)
  }

  const citedDocNames = Array.from(new Set(topChunks.map((s) => s.doc.name)))
  const citations: Citation[] = citedDocNames.map((name) => ({
    type: 'DOCUMENT',
    source: name,
    query_used: '',
  }))

  await persistAiMessage({ sessionId, userId, text: textFinal, citations, chartData: null })
  emitStatus('complete', 'Selesai.')
  emitComplete(textFinal, citations, null)
}

async function runChatBranch(
  text: string,
  sessionId: string,
  userId: string,
  companyId: string,
  emitStatus: StatusEvent,
  emitToken: TokenEvent,
  emitComplete: CompleteEvent,
): Promise<void> {
  emitStatus('generating', 'Menyusun jawaban...')
  let textFinal = ''
  for await (const token of streamChat(text, companyId)) {
    textFinal += token
    emitToken(token)
  }
  const citations: Citation[] = []
  await persistAiMessage({ sessionId, userId, text: textFinal, citations, chartData: null })
  emitStatus('complete', 'Selesai.')
  emitComplete(textFinal, citations, null)
}

// ---------------------------------------------------------------------------
// Top-level handler
// ---------------------------------------------------------------------------

async function handleMessage(
  payload: UserMessagePayload,
  emitStatus: StatusEvent,
  emitToken: TokenEvent,
  emitComplete: CompleteEvent,
): Promise<void> {
  const { text, sessionId, userId, companyId, integrationId } = payload
  try {
    // 1) routing
    emitStatus('routing', 'AI sedang menganalisis pertanyaan Anda...')

    const [integrationCount, documentCount] = await Promise.all([
      db.integration.count({ where: { companyId, status: 'active' } }),
      db.document.count({ where: { companyId, status: 'ready' } }),
    ])

    const hasIntegrations = integrationCount > 0
    const hasDocuments = documentCount > 0

    const { decision } = await routeQuery({
      question: text,
      hasIntegrations,
      hasDocuments,
      companyId,
    })

    // Safety fallbacks: if the router picks SQL but no integrations, or RAG
    // but no documents, gracefully degrade to CHAT.
    if (decision === 'SQL' && !hasIntegrations) {
      await runChatBranch(text, sessionId, userId, companyId, emitStatus, emitToken, emitComplete)
      return
    }
    if (decision === 'RAG' && !hasDocuments) {
      await runChatBranch(text, sessionId, userId, companyId, emitStatus, emitToken, emitComplete)
      return
    }

    if (decision === 'SQL') {
      await runSqlBranch(
        text,
        sessionId,
        userId,
        companyId,
        integrationId,
        emitStatus,
        emitToken,
        emitComplete,
      )
    } else if (decision === 'RAG') {
      await runRagBranch(text, sessionId, userId, companyId, emitStatus, emitToken, emitComplete)
    } else {
      await runChatBranch(text, sessionId, userId, companyId, emitStatus, emitToken, emitComplete)
    }
  } catch (err) {
    console.error('[chat-service] handleMessage error:', err)
    emitStatus('error', 'Terjadi kesalahan internal.')
    emitComplete(
      'Maaf, terjadi kesalahan saat memproses pertanyaan Anda. Tim kami telah diberi tahu.',
      [],
    )
  }
}

// ---------------------------------------------------------------------------
// HTTP + Socket.io bootstrap
// ---------------------------------------------------------------------------

const httpServer = createServer()

const io = new Server(httpServer, {
  // DO NOT change the path — Caddy uses it to route to the correct port.
  // Note: because path is '/', socket.io owns ALL HTTP requests on this server.
  path: '/',
  // CORS from config (WS_CORS_ORIGIN). Empty list => reflect the request Origin
  // (never a wildcard). Restrict via env in production.
  cors: {
    origin: serverConfig.wsCorsOrigins.length > 0 ? serverConfig.wsCorsOrigins : true,
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

io.on('connection', (socket: Socket) => {
  console.log(`[chat-service] client connected: ${socket.id}`)

  const emitStatus: StatusEvent = (status, message) => {
    socket.emit('status_update', { status, message })
  }
  const emitToken: TokenEvent = (token) => {
    socket.emit('text_stream', { token })
  }
  const emitComplete: CompleteEvent = (textFinal, citations, chartData) => {
    socket.emit('message_complete', {
      text_final: textFinal,
      citations,
      chartData: chartData ?? null,
    })
  }

  // Serialize messages per-socket so token streams never interleave (which would
  // corrupt the client's "last AI message"). A long answer fully completes before
  // the next user_message starts processing.
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = (fn: () => Promise<void>) => {
    chain = chain.then(fn).catch((e) => console.error('[chat-service] queue error:', e))
  }

  // Direct payload form: socket.emit('user_message', { text, sessionId, ... })
  socket.on('user_message', async (raw: unknown) => {
    const payload = normalizePayload(raw)
    if (!payload) {
      emitStatus('error', 'Payload tidak lengkap.')
      emitComplete('Permintaan tidak valid: payload hilang atau format salah.', [])
      return
    }
    const identity = await resolveIdentity(payload)
    if (!identity.ok) {
      emitStatus('error', identity.reason)
      emitComplete(`Permintaan ditolak: ${identity.reason}`, [])
      return
    }
    enqueue(() => handleMessage(payload, emitStatus, emitToken, emitComplete))
  })

  // Wrapped envelope form: socket.emit('message', { event: 'user_message', payload: {...} })
  socket.on('message', async (msg: unknown) => {
    const m = msg as { event?: string; payload?: unknown }
    if (m && m.event === 'user_message') {
      const payload = normalizePayload(m.payload)
      if (!payload) {
        emitStatus('error', 'Payload tidak lengkap.')
        emitComplete('Permintaan tidak valid: payload hilang atau format salah.', [])
        return
      }
      const identity = await resolveIdentity(payload)
      if (!identity.ok) {
        emitStatus('error', identity.reason)
        emitComplete(`Permintaan ditolak: ${identity.reason}`, [])
        return
      }
      enqueue(() => handleMessage(payload, emitStatus, emitToken, emitComplete))
    }
  })

  socket.on('disconnect', (reason: string) => {
    console.log(`[chat-service] client disconnected: ${socket.id} (${reason})`)
  })

  socket.on('error', (err: unknown) => {
    console.error(`[chat-service] socket error (${socket.id}):`, err)
  })
})

function normalizePayload(raw: unknown): UserMessagePayload | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const text = typeof p.text === 'string' ? p.text : undefined
  const sessionId = typeof p.sessionId === 'string' ? p.sessionId : undefined
  const userId = typeof p.userId === 'string' ? p.userId : undefined
  const companyId = typeof p.companyId === 'string' ? p.companyId : undefined
  const integrationId = typeof p.integrationId === 'string' ? p.integrationId : undefined
  if (!text || !sessionId || !userId || !companyId) return null
  return { text, sessionId, userId, companyId, integrationId }
}

httpServer.listen(PORT, () => {
  console.log(`[chat-service] WebSocket server running on port ${PORT} (path: "/")`)
})

// Graceful shutdown
function shutdown(signal: string) {
  console.log(`[chat-service] received ${signal}, shutting down...`)
  io.close(() => {
    httpServer.close(() => {
      console.log('[chat-service] closed')
      process.exit(0)
    })
  })
  // Force-exit after 5s if graceful close hangs.
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
