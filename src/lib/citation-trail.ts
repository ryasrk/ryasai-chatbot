import type { RetrievedChunk } from '@/lib/rag'
import type { DualLevelResult } from '@/lib/knowledge-graph'

export interface CitationTrail {
  entity: string
  relation: string
  chunkId: string
  relevance: number
}

/**
 * Build citation trails from KG retrieval results + retrieved chunks.
 * Traces which entity and relation led to each KG-matched chunk.
 * ponytail: uses graphContext string parsing — upgrade to structured relation
 * data from dualLevelRetrieval if precision matters.
 */
export function buildCitationTrail(
  query: string,
  kgResult: DualLevelResult,
  chunks: RetrievedChunk[],
): CitationTrail[] {
  if (kgResult.allChunkIds.length === 0) return []

  const chunkMap = new Map(chunks.map((c) => [c.chunkId, c]))
  const localSet = new Set(kgResult.localChunks)
  const trails: CitationTrail[] = []
  const queryTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2)

  const relations = parseGraphContext(kgResult.graphContext)

  for (const chunkId of kgResult.allChunkIds) {
    const chunk = chunkMap.get(chunkId)
    if (!chunk) continue

    const isLocal = localSet.has(chunkId)
    const entity = matchEntity(kgResult.matchedEntities, chunk.content, queryTokens)
    const relation = matchRelation(relations, entity, chunk.content)

    trails.push({
      entity,
      relation: relation ?? (isLocal ? 'local entity match' : 'global relation chain'),
      chunkId,
      relevance: isLocal ? Math.min(1, chunk.score * 1.3) : Math.min(0.85, chunk.score * 0.8),
    })
  }

  return trails.sort((a, b) => b.relevance - a.relevance)
}

interface ParsedRelation {
  source: string
  target: string
  description: string
}

function parseGraphContext(graphContext: string): ParsedRelation[] {
  if (!graphContext) return []
  const lines = graphContext.split('\n').filter((l) => l.includes('→'))
  return lines.map((line) => {
    const match = line.match(/\[(.+?)\]\s*→\s*(.+?)\s*→\s*\[(.+?)\]/)
    if (match) {
      return { source: match[1].trim(), target: match[3].trim(), description: match[2].trim() }
    }
    return { source: '', target: '', description: line.trim() }
  })
}

function matchEntity(entities: string[], content: string, queryTokens: string[]): string {
  const lower = content.toLowerCase()
  for (const entity of entities) {
    if (lower.includes(entity.toLowerCase())) return entity
  }
  for (const token of queryTokens) {
    for (const entity of entities) {
      if (entity.toLowerCase().includes(token)) return entity
    }
  }
  return entities[0] ?? 'unknown'
}

function matchRelation(relations: ParsedRelation[], entity: string, content: string): string | null {
  const lower = content.toLowerCase()
  for (const rel of relations) {
    if (rel.source.toLowerCase() === entity.toLowerCase() || rel.target.toLowerCase() === entity.toLowerCase()) {
      return rel.description
    }
    if (rel.description && lower.includes(rel.description.toLowerCase().slice(0, 20))) {
      return rel.description
    }
  }
  return null
}
