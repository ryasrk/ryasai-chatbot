/** Runtime-managed indexes are additive and do not change the model schema. */
const RUNTIME_INDEXES = new Set([
  'DocumentChunk_embedding_hnsw', 'KgRelation_source_trgm', 'KgRelation_target_trgm',
])

export function canBaselineSchema(sql: string): boolean {
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map((part) => part.trim()).filter(Boolean)
  return statements.every((statement) => {
    const match = /^DROP INDEX "([A-Za-z_][A-Za-z0-9_]*)"$/.exec(statement)
    return match !== null && RUNTIME_INDEXES.has(match[1])
  })
}
