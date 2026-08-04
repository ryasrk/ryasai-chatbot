/**
 * Cognee — shared types and pure dataset helpers.
 * Leaf module: no deps on other cognee split files.
 */
export interface ChatTurnMemory {
  sessionId?: string
  userId?: string
  userMessage: string
  aiMessage: string
  toolRuns: Array<{ type: string; status: string; latencyMs: number }>
}

export interface GraphSearchResult {
  text: string
  source: 'summary' | 'chunk' | 'entity' | 'relationship'
  score?: number
}

/**
 * Dataset names are org-scoped. In `postgres` mode several orgs can point at the
 * same cognee database, so the per-org client and per-org store directory aren't
 * enough on their own — the dataset name is the isolation boundary inside a
 * shared DB. Falls back to a dead name with no org context so a caller that
 * forgot enterWithOrg reads and writes nothing instead of the shared 'default'.
 */
import { getOrgContext } from '@/lib/prisma-tenant'

function orgKey(): string {
  return getOrgContext() ?? 'no-org'
}

export function datasetFor(): string {
  return `org:${orgKey()}`
}

export function kbDatasetFor(): string {
  return `org:${orgKey()}:kb`
}
