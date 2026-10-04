/**
 * Schema understanding generated once per integration and cached: per-table descriptions and a business profile of
 * the database, both fed to the SQL generator and the router as context. Split from `ai.ts`.
 */
import { chatOnce } from '@/lib/ai-chat'
import { DATABASE_PROFILE_VERSION } from '@/lib/profile-version'

export interface TableSummaryInput {
  tableName: string
  columns: Array<{ name: string; type: string; primaryKey?: boolean }>
  rowCount?: number | null
  sampleRow?: Record<string, unknown> | null
}

export async function generateSchemaDescriptions(args: {
  integrationName: string
  tables: TableSummaryInput[]
}): Promise<Record<string, string>> {
  if (args.tables.length === 0) return {}

  const tableTexts = args.tables.map((t) => {
    const cols = t.columns.map((c) => `${c.name}:${c.type}${c.primaryKey ? ' (PK)' : ''}`).join(', ')
    const sample = t.sampleRow ? `\n  Sample row: ${JSON.stringify(t.sampleRow).slice(0, 300)}` : ''
    const rows = t.rowCount != null ? ` (${t.rowCount} rows)` : ''
    return `Table: ${t.tableName}${rows}\n  Columns: ${cols}${sample}`
  }).join('\n\n')

  const raw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'You are a database schema analyst. For each table, write a concise 1-sentence description of what the table contains and its purpose. ' +
          'Focus on business meaning, not technical details. ' +
          'Output ONLY valid JSON (no markdown fence): {"tableName": "description", ...}',
      },
      {
        role: 'user',
        content:
          `Database: ${args.integrationName}\n\nTables:\n${tableTexts}\n\n` +
          `Generate a JSON object mapping each table name to a 1-sentence description.`,
      },
    ],
    { purpose: 'schema-description' },
  )

  try {
    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    return JSON.parse(cleaned) as Record<string, string>
  } catch (e) {
    console.warn('[ai] schema reflection JSON parse failed:', e instanceof Error ? e.message : String(e))
    // ponytail: LLM returned malformed JSON — return empty, don't block schema reflection
    return {}
  }
}

// ---------------------------------------------------------------------------
// Database Profile generation — LLM analyzes the full schema and produces a
// rich business context document. This is the "what database is this?" answer
// that gets injected into every Text-to-SQL call so the model understands:
//   1. What business domain the database serves (mining safety, HR, e-commerce)
//   2. How tables relate to each other (participants → companies → sites)
//   3. Domain vocabulary (abbreviations, non-English terms)
//   4. Querying hints (which columns to filter on, what "active" means)
//
// Generated once at connection test time, stored in Integration.businessContext.
// ---------------------------------------------------------------------------

export async function generateDatabaseProfile(args: {
  integrationName: string
  tables: TableSummaryInput[]
}): Promise<string> {
  if (args.tables.length === 0) return ''

  const tableTexts = args.tables.map((t) => {
    const cols = t.columns.map((c) => `${c.name}:${c.type}${c.primaryKey ? ' (PK)' : ''}`).join(', ')
    const sample = t.sampleRow ? `\n  Sample: ${JSON.stringify(t.sampleRow).slice(0, 300)}` : ''
    const rows = t.rowCount != null ? ` (${t.rowCount} rows)` : ''
    return `${t.tableName}${rows}: ${cols}${sample}`
  }).join('\n')

  const raw = await chatOnce(
    [
      {
        role: 'system',
        content:
          'You are a database analyst. Analyze the complete schema of a database and produce a ' +
          'BUSINESS CONTEXT document that will help a Text-to-SQL AI understand the domain. ' +
          'The document must be plain text (not JSON) with these sections:\n\n' +
          '## DOMAIN\nWhat business domain is this database for? (e.g. "HR and payroll", ' +
          '"e-commerce", "inventory management"). What organization type?\n\n' +
          '## CORE ENTITIES\nList the 5-10 most important tables and what they represent in business ' +
          'terms. Use the business name, not the table name.\n\n' +
          '## KEY RELATIONSHIPS\nHow do the core entities connect? (e.g. "employees belong to ' +
          'departments, have payroll records, attend training sessions")\n\n' +
          '## DOMAIN GLOSSARY\nDefine domain-specific terms and abbreviations found in table/column ' +
          'names. Include non-English terms if present.\n\n' +
          '## QUERY HINTS\nPractical tips for writing correct SQL:\n' +
          '- Which column indicates "active" status for key tables\n' +
          '- Which tables should be used for common business questions\n' +
          '- Which columns to avoid filtering on unnecessarily\n' +
          '- When to use COUNT(*) vs filtering (e.g. "for vendor count, count ALL companies — do NOT filter by name patterns")\n' +
          '- Common pitfalls (e.g. soft-delete columns, case sensitivity)\n' +
          '- For each core entity, note: which table to query, what "active" means, and what NOT to filter on\n\n' +
          'Keep it concise — aim for 300-500 words total. Do NOT include SQL examples.',
      },
      {
        role: 'user',
        content:
          `Database name: ${args.integrationName}\n\n` +
          `Complete schema (${args.tables.length} tables):\n${tableTexts}\n\n` +
          `Generate the business context document.`,
      },
    ],
    { purpose: 'schema-description' },
  )

  const body = raw.trim()
  if (!body) return ''
  // The marker is prepended, not asked of the model: a model told to emit it will
  // sometimes forget, and a marker that is sometimes missing cannot be trusted.
  return `<!-- profile-version: ${DATABASE_PROFILE_VERSION} -->\n${body}`
}
