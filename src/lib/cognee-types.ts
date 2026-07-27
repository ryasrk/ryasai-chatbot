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

export function datasetFor(): string {
  return 'default'
}

export function kbDatasetFor(): string {
  return 'default:kb'
}
