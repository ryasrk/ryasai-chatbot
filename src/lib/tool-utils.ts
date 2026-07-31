import type { ChartData, Citation } from '@/lib/types'
import type { QueryRow, ReflectedTable } from '@/lib/connectors'

// ---------------------------------------------------------------------------
// Shared types — used by tool-router, tool-branches, and stream-preparers.
// ----------------------------------------------------------------------------

type ToolRunStatus = 'success' | 'error' | 'blocked'

export interface PendingToolRun {
  type: 'RAG' | 'SQL' | 'REST_API' | 'CHAT' | 'PLUGIN'
  status: ToolRunStatus
  latencyMs?: number
  inputSummary: string
  outputSummary?: string
  errorMessage?: string
  restApiEndpointId?: string
}

export interface CompletionResult {
  answer: string
  citations: Citation[]
  toolRuns: PendingToolRun[]
  chartData: ChartData | null
  integrationId?: string
  usage?: { promptTokens: number; completionTokens: number }
  citationTrail?: Array<{ entity: string; relation: string; chunkId: string; relevance: number }>
}

export interface ChatHistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

export interface StreamingCompletionResult {
  toolRuns: PendingToolRun[]
  citations: Citation[]
  chartData: ChartData | null
  integrationId?: string
  stream: AsyncGenerator<string, void, unknown>
  usage?: { promptTokens: number; completionTokens: number }
  citationTrail?: Array<{ entity: string; relation: string; chunkId: string; relevance: number }>
}

// ---------------------------------------------------------------------------
// SQL concurrency limiter — in-memory semaphore.
// ponytail: per-instance, not distributed. Max 3 concurrent queries per
// integration to prevent database lock contention. Upgrade to Redis-backed
// semaphore when scaling.
// ---------------------------------------------------------------------------

const SQL_MAX_CONCURRENT = 3
const _sqlSemaphores = new Map<string, { running: number; queue: Array<() => void> }>()

export function withSqlConcurrency<T>(integrationId: string, fn: () => Promise<T>): Promise<T> {
  let sem = _sqlSemaphores.get(integrationId)
  if (!sem) {
    sem = { running: 0, queue: [] }
    _sqlSemaphores.set(integrationId, sem)
  }
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      sem!.running += 1
      try {
        const result = await fn()
        resolve(result)
      } catch (e) {
        reject(e)
      } finally {
        sem!.running -= 1
        const next = sem!.queue.shift()
        if (next) next()
      }
    }
    if (sem.running < SQL_MAX_CONCURRENT) {
      run()
    } else {
      sem.queue.push(run)
    }
  })
}

// ---------------------------------------------------------------------------
// Chart + citation builders
// ---------------------------------------------------------------------------

export function buildChartDataFromRows(rows: QueryRow[]): ChartData | null {
  if (!rows || rows.length < 2) return null
  const sampleKeys = Object.keys(rows[0] ?? {})
  if (sampleKeys.length < 2) return null

  let xKey: string | null = null
  const yKeys: string[] = []
  let looksLikeTimeSeries = false

  for (const key of sampleKeys) {
    const sampleValues = rows.slice(0, 6).map((row) => row[key])
    if (sampleValues.every(isNumeric)) {
      yKeys.push(key)
    } else if (
      !xKey &&
      sampleValues.every((value) => typeof value === 'string' || typeof value === 'number')
    ) {
      xKey = key
      if (sampleValues.some(isDateString)) looksLikeTimeSeries = true
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

export function buildDocumentCitation(args: {
  documentName: string
  chunkIndex: number
  content: string
  score: number
}): Citation {
  const snippet = args.content.length > 240 ? `${args.content.slice(0, 240)}...` : args.content
  return {
    type: 'DOCUMENT',
    source: args.documentName,
    query_used: `chunk #${args.chunkIndex}`,
    chunkIndex: args.chunkIndex,
    snippet,
    score: args.score,
  }
}

// ---------------------------------------------------------------------------
// SQL error sanitization — strip credentials, connection strings, and
// schema-internal noise.
// ---------------------------------------------------------------------------

export function sanitizeSqlError(msg: string): string {
  return msg
    .replace(/postgres:\/\/[^\s]+/g, 'postgres://***')
    .replace(/mysql:\/\/[^\s]+/g, 'mysql://***')
    .replace(/password\s*=\s*[^\s;]+/gi, 'password=***')
    .replace(/user\s*=\s*[^\s;]+/gi, 'user=***')
    .slice(0, 300)
}

// ---------------------------------------------------------------------------
// Text + JSON helpers
// ---------------------------------------------------------------------------

export function summarize(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value
}

export function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function safeParseColumns(raw: string): ReflectedTable['columns'] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((column) => ({
      name: String(column?.name ?? ''),
      type: String(column?.type ?? ''),
      primaryKey: Boolean(column?.primaryKey) || undefined,
      notNull: Boolean(column?.notNull) || undefined,
      foreignKey: column?.foreignKey ? String(column.foreignKey) : undefined,
      distinctValues: Array.isArray(column?.distinctValues) ? column.distinctValues.map(String) : undefined,
    }))
  } catch {
    return []
  }
}

export function safeParseSampleRow(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
    return undefined
  } catch {
    return undefined
  }
}

export function extractTableName(sql: string): string {
  const match = sql.match(/\b(?:FROM|JOIN)\s+["`]?(\w+)["`]?/i)
  return match ? match[1] : 'query'
}

export function jsonRowsToChart(value: unknown): ChartData | null {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : []
  if (!rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) return null
  return buildChartDataFromRows(rows as QueryRow[])
}

export function unavailableDataSourceResult(
  type: PendingToolRun['type'],
  question: string,
  started: number,
): CompletionResult {
  return {
    answer: 'The required data source is not yet available or not configured as active.',
    citations: [],
    chartData: null,
    toolRuns: [
      {
        type,
        status: 'blocked',
        latencyMs: Date.now() - started,
        inputSummary: summarize(question),
        errorMessage: 'Data source unavailable.',
      },
    ],
  }
}

function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') return true
  if (typeof value === 'bigint') return true
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return true
  }
  return false
}

function isDateString(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{2}\/\d{2}\/\d{4}/.test(value)
}
