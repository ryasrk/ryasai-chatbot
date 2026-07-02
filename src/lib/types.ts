/**
 * Shared client-side types — mirror the Prisma models / API responses.
 * Kept in a single file so all frontend views import from one place.
 */

export type Role = 'admin' | 'manager' | 'staff'

export interface ActiveUser {
  userId: string
  companyId: string
  role: Role
  name: string
  email: string
  companyName?: string
}

export interface Integration {
  id: string
  name: string
  type: 'DATABASE' | 'API'
  provider: string
  status: 'active' | 'inactive' | 'error'
  lastTestedAt: string | null
  lastTestOk: boolean | null
  createdAt: string
  tableCount?: number
  maskedConfig?: Record<string, unknown>
  schemas?: IntegrationSchemaRow[]
}

export interface IntegrationSchemaRow {
  id: string
  tableName: string
  columns: { name: string; type: string }[]
  rowCount: number | null
  reflectedAt: string
}

export interface DocumentItem {
  id: string
  name: string
  type: string
  sizeBytes: number
  mimeType: string
  status: string
  category: string | null
  description: string | null
  createdAt: string
  chunkCount: number
}

export interface ChatMessageItem {
  id: string
  sender: 'user' | 'ai' | 'system'
  text: string
  status?: string | null
  citations?: Citation[] | null
  chartData?: ChartData | null
  createdAt: string
  integration?: { id: string; name: string } | null
}

export interface Citation {
  type: 'DATABASE' | 'DOCUMENT' | string
  source: string
  query_used?: string
  chunkIndex?: number
  snippet?: string
  score?: number
}

export interface ChartData {
  type: 'bar' | 'line' | 'pie'
  data: Record<string, unknown>[]
  xKey: string
  yKeys: string[]
}

export interface ChatSessionItem {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  _count?: { messages: number }
}

export interface AuditLogItem {
  id: string
  action: string
  severity: 'info' | 'warning' | 'critical'
  detail: string
  ipAddress: string | null
  createdAt: string
  user: { id: string; name: string; email: string } | null
}

export interface AnalyticsData {
  totals: {
    integrations: number
    documents: number
    chatSessions: number
    queriesExecuted: number
    guardrailBlocks: number
  }
  querySuccessRate: number
  recentQueries: {
    id: string
    naturalQuery: string
    generatedSql: string
    rowCount: number | null
    executionMs: number | null
    success: boolean
    createdAt: string
    integration: { name: string }
    user: { name: string }
  }[]
  queryTrend: { date: string; count: number }[]
  chatTrend: { date: string; count: number }[]
  auditBySeverity: { info: number; warning: number; critical: number }
  integrationsByProvider: { provider: string; count: number }[]
  documentsByCategory: { category: string; count: number }[]
}

export interface QueryResult {
  ok: boolean
  sql?: string
  explanation?: string
  rows?: Record<string, unknown>[]
  rowCount?: number
  executionMs?: number
  reason?: string
  generatedSql?: string
}

export interface PublicLlmConfig {
  configured: boolean
  provider: string
  baseUrl: string
  model: string
  apiKeyMasked: string | null
  availableModels: string[]
  lastModelSyncAt: string | null
  embeddingProvider: string
  embeddingBaseUrl: string
  embeddingModel: string
  embeddingApiKeyMasked: string | null
  embeddingAvailableModels: string[]
  lastEmbeddingModelSyncAt: string | null
  updatedAt: string | null
}
