import { describe, expect, test } from 'bun:test'
import { canBaselineSchema } from './migration-baseline'

describe('legacy database adoption', () => {
  test('an identical schema or only known runtime indexes can be baselined', () => {
    expect(canBaselineSchema('-- No difference')).toBe(true)
    expect(canBaselineSchema('-- DropIndex\nDROP INDEX "DocumentChunk_embedding_hnsw";')).toBe(true)
    expect(canBaselineSchema('DROP INDEX "KgRelation_source_trgm"; DROP INDEX "KgRelation_target_trgm";')).toBe(true)
  })
  test('missing columns, changed tables and unknown indexes require operator action', () => {
    for (const sql of [
      'ALTER TABLE "Document" ADD COLUMN content TEXT;',
      'DROP TABLE "User";',
      'DROP INDEX "User_email_key";',
      'CREATE TABLE "Organization" (id TEXT);',
      'DROP INDEX "DocumentChunk_embedding_hnsw"; DELETE FROM "User";',
    ]) expect(canBaselineSchema(sql)).toBe(false)
  })
})
