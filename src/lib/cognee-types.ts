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
 * ponytail: every searchType string we may send to cognee must be one of the
 * 15 names the SDK serializes (SearchTypeString in @cognee/cognee-ts types).
 * Anything else fails remotely with "unknown SearchType '<X>'" and the whole
 * strategy is wasted. This set is the single source of truth for validation;
 * keep it in sync with node_modules/@cognee/cognee-ts/lib/types.d.ts.
 */
export const COGNEE_SEARCH_TYPES: ReadonlySet<string> = new Set([
  'SUMMARIES', 'CHUNKS', 'RAG_COMPLETION', 'TRIPLET_COMPLETION', 'GRAPH_COMPLETION',
  'GRAPH_SUMMARY_COMPLETION', 'CYPHER', 'NATURAL_LANGUAGE', 'GRAPH_COMPLETION_COT',
  'GRAPH_COMPLETION_CONTEXT_EXTENSION', 'FEELING_LUCKY', 'FEEDBACK', 'TEMPORAL',
  'CODING_RULES', 'CHUNKS_LEXICAL',
])

export function isValidSearchType(t: string): boolean {
  return COGNEE_SEARCH_TYPES.has(t)
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
