/**
 * Schema enrichment — generates + persists LLM descriptions for integration
 * tables. Called after schema reflection at connection test time.
 */
import { db } from '@/lib/db'
import { generateSchemaDescriptions, type TableSummaryInput } from '@/lib/ai'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('schema-enrichment')

export async function enrichSchemaDescriptions(integrationId: string, integrationName: string): Promise<void> {
  const schemas = await db.integrationSchema.findMany({ where: { integrationId } })
  if (schemas.length === 0) return

  const tables: TableSummaryInput[] = schemas.map((s) => ({
    tableName: s.tableName,
    columns: safeParseColumns(s.columns),
    rowCount: s.rowCount,
    sampleRow: safeParseSampleRow(s.sampleRow),
  }))

  try {
    const descriptions = await generateSchemaDescriptions({ integrationName, tables })
    for (const s of schemas) {
      const desc = descriptions[s.tableName]
      if (desc) {
        await db.integrationSchema.update({ where: { id: s.id }, data: { description: desc.slice(0, 500) } })
      }
    }
    log.info('Schema descriptions enriched', { integrationId, count: Object.keys(descriptions).length })
  } catch (e) {
    log.warn('Schema description enrichment failed', { integrationId, error: e instanceof Error ? e.message : String(e) })
  }
}

export function safeParseColumns(raw: string): TableSummaryInput['columns'] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((c: Record<string, unknown>) => ({
      name: String(c?.name ?? ''),
      type: String(c?.type ?? ''),
      primaryKey: Boolean(c?.primaryKey) || undefined,
    }))
  } catch {
    return []
  }
}

export function safeParseSampleRow(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
