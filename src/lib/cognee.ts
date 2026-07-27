/**
 * Cognee integration — memory + knowledge graph layer.
 * ----------------------------------------------------------------------------
 * Main entry: re-exports the split modules + health/stats monitoring.
 *
 * Split files:
 *   - cognee-types.ts          — shared types + pure dataset helpers (leaf)
 *   - cognee-core.ts           — settings cache, client init, shared helpers
 *   - cognee-memory.ts         — rememberChatTurn, recallContext, session cache
 *   - cognee-knowledge-graph.ts — cognify, graph recall, forget/reset
 *
 * Provides:
 *   - rememberChatTurn()  — fire-and-forget chat memory write
 *   - recallContext()     — graph + session recall for router/planner prompts
 *   - cognifyDocument()   — single-doc entity extraction + graph build
 *   - cognifyBatch()      — batch cognify for scalability (millions of docs)
 *   - recallKnowledgeGraph() — graph-grounded retrieval for RAG outer ring
 *   - forgetAll() / forgetKnowledgeGraph() — GDPR reset
 *   - cogneeHealth() / cogneeStats() — monitoring
 *   - resetCognee() — full state reset (admin)
 *
 * Scaling strategy:
 *   - Dev: SQLite + LanceDB + Kuzu (zero services)
 *   - Prod: Postgres + pgvector (single DB, scales to millions)
 *   - Batch cognify: process 50 docs per cognify call (reduces LLM calls)
 *   - Incremental: only cognify new documents (skip already-processed)
 *   - Fire-and-forget: never block user response on memory write
 */
import { getCogneeSettings, getCogneeClient } from './cognee-core'
import { db } from '@/lib/db'

export * from './cognee-types'
export * from './cognee-memory'
export * from './cognee-knowledge-graph'
export { invalidateCogneeSettings } from './cognee-core'

// ---------------------------------------------------------------------------
// Health + stats
// ---------------------------------------------------------------------------

export async function cogneeHealth(): Promise<{
  enabled: boolean
  connected: boolean
  mode: 'local' | 'postgres' | 'disabled'
}> {
  const settings = await getCogneeSettings()
  if (!settings.enabled) return { enabled: false, connected: false, mode: 'disabled' }
  const client = await getCogneeClient()
  return { enabled: true, connected: !!client, mode: settings.dbProvider }
}

export async function cogneeStats(): Promise<{
  enabled: boolean
  connected: boolean
  mode: 'local' | 'postgres' | 'disabled'
  documents: { total: number; cognified: number; pending: number; failed: number }
  batchSize: number
  maxRetries: number
}> {
  const health = await cogneeHealth()
  const settings = await getCogneeSettings()
  if (!health.enabled) {
    return { ...health, documents: { total: 0, cognified: 0, pending: 0, failed: 0 }, batchSize: 0, maxRetries: 0 }
  }

  const docs = await db.document.groupBy({
    by: ['cognifyStatus'],
    _count: { id: true },
  }).catch(() => [])

  const cognified = docs.find((d) => d.cognifyStatus === 'completed')?._count.id ?? 0
  const failed = docs.find((d) => d.cognifyStatus === 'failed')?._count.id ?? 0
  const processing = docs.find((d) => d.cognifyStatus === 'processing')?._count.id ?? 0
  const total = docs.reduce((sum, d) => sum + d._count.id, 0)
  const pending = total - cognified - failed - processing

  return {
    ...health,
    documents: { total, cognified, pending, failed },
    batchSize: settings.batchSize,
    maxRetries: settings.maxRetries,
  }
}
