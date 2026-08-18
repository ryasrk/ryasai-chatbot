/**
 * Text-to-SQL Evaluation Harness — Execution-Accuracy Style
 * ----------------------------------------------------------------------------
 * Measures SQL generation quality against a golden question set for a given
 * integration:
 *   1. Execution accuracy — does the generated SQL run without error?
 *   2. Result agreement   — do the rows match the expected result set?
 *   3. Keyword presence   — do expected SQL keywords appear (ILIKE, LIMIT, ...)?
 *
 * ponytail: prompts changes (ILIKE/LIKE rules, repair loop, truncation notes)
 * MUST be measurable — this harness exists so prompt edits are not vibes-based.
 * Same pattern as benchmark/rag-eval.ts (uses the app's LLM config).
 *
 * Usage:
 *   bun run benchmark/sql-eval.ts --integration <id>            # all questions
 *   bun run benchmark/sql-eval.ts --integration <id> --limit 5 # first 5
 *   bun run benchmark/sql-eval.ts --integration <id> --file my-questions.json
 *
 * Custom question file format (JSON array):
 *   [{ "id": "sql-001", "question": "...", "expectedKeywords": ["ILIKE", "LIMIT"],
 *      "expectedRowCount": 42 }]
 */
import { db } from '@/lib/db'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { generateSql } from '@/lib/ai'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'
import { describeSchema } from '@/lib/connectors'
import { decryptConfig } from '@/lib/crypto'
import { connectorRegistry } from '@/lib/connectors'
import { safeParseColumns, safeParseSampleRow } from '@/lib/tool-utils'
import { getRoleLlmConfig } from '@/lib/llm-config'
import { readFileSync, writeFileSync } from 'fs'

interface SqlEvalQuestion {
  id: string
  question: string
  /** Keywords expected in the generated SQL (e.g. ILIKE, CURRENT_DATE, LIMIT). */
  expectedKeywords?: string[]
  /** Exact expected row count (execution result agreement). */
  expectedRowCount?: number
  /** Expected substring of a value in the first row (loose value check). */
  expectedFirstRowContains?: string
}

const DEFAULT_SQL_EVAL_QUESTIONS: SqlEvalQuestion[] = [
  {
    id: 'sql-001',
    question: 'How many participants are there in total?',
    expectedKeywords: ['COUNT(*)'],
  },
  {
    id: 'sql-002',
    question: 'Find all records mentioning john in the name',
    // ponytail: the ILIKE rule — case-insensitive matching is the regression
    // this question guards (bare LIKE / = on names silently misses rows).
    expectedKeywords: ['ILIKE', 'LOWER', 'positionCaseInsensitive'],
  },
  {
    id: 'sql-003',
    question: 'Show data from yesterday',
    expectedKeywords: ['CURRENT_DATE'],
  },
  {
    id: 'sql-004',
    question: 'List the first 20 rows of the largest table',
    expectedKeywords: ['LIMIT'],
  },
]

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(): { integrationId: string; limit: number; file?: string; out?: string } {
  const args = process.argv.slice(2)
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const integrationId = get('integration')
  if (!integrationId) {
    console.error('Usage: bun run benchmark/sql-eval.ts --integration <id> [--limit N] [--file q.json] [--out results.json]')
    process.exit(1)
  }
  return {
    integrationId,
    limit: Number(get('limit') ?? 0) || 0,
    file: get('file'),
    out: get('out'),
  }
}

async function main() {
  const opts = parseArgs()

  // Org context — the tenant extension requires it for all DB reads below.
  const orgId = process.env.EVAL_ORG_ID
  if (!orgId) {
    console.error('Set EVAL_ORG_ID (the organization that owns the integration).')
    process.exit(1)
  }
  enterWithOrg(orgId)

  // LLM must be configured for the query role (generateSql uses it).
  const llm = await getRoleLlmConfig('query')
  if (!llm) {
    console.error('No LLM configured for the "query" role. Configure Settings > AI first.')
    process.exit(1)
  }

  const integration = await db.integration.findFirst({
    where: { id: opts.integrationId, status: 'active' },
    include: { schemas: { orderBy: { tableName: 'asc' } } },
  })
  if (!integration || integration.schemas.length === 0) {
    console.error(`Integration ${opts.integrationId} not found or has no cached schema.`)
    process.exit(1)
  }

  const schemaDescription = describeSchema(
    integration.schemas.map((s) => ({
      tableName: s.tableName,
      columns: safeParseColumns(s.columns),
      rowCount: s.rowCount ?? undefined,
      sampleRow: safeParseSampleRow(s.sampleRow),
      description: s.description,
    })),
  )

  const questions: SqlEvalQuestion[] = opts.file
    ? (JSON.parse(readFileSync(opts.file, 'utf8')) as SqlEvalQuestion[])
    : DEFAULT_SQL_EVAL_QUESTIONS
  const selected = opts.limit > 0 ? questions.slice(0, opts.limit) : questions

  const connector = connectorRegistry.getConnector(
    integration.id,
    integration.provider,
    decryptConfig(integration.encryptedConfig),
  )

  const results: Array<
    SqlEvalQuestion & {
      sql?: string
      executed: boolean
      error?: string
      rowCount?: number
      keywordHits: number
      keywordTotal: number
      rowCountMatch?: boolean
      firstRowMatch?: boolean
      latencyMs: number
    }
  > = []

  for (const q of selected) {
    const t0 = Date.now()
    try {
      const { sql } = await generateSql({
        question: q.question,
        schemaDescription,
        provider: integration.provider,
        businessContext: integration.businessContext,
      })
      const guard = validateAndSanitizeLlmSql(sql)
      if (!guard.ok) {
        results.push({ ...q, sql, executed: false, error: `GUARDRAIL: ${guard.reason}`, keywordHits: 0, keywordTotal: q.expectedKeywords?.length ?? 0, latencyMs: Date.now() - t0 })
        continue
      }
      const finalSql = guard.sanitized
      const exec = await connector.executeQuery(finalSql)
      const sqlUpper = finalSql.toUpperCase()
      const keywordHits = (q.expectedKeywords ?? []).filter((k) =>
        sqlUpper.includes(k.toUpperCase()),
      ).length
      const firstRow = exec.rows[0]
      const firstRowStr = firstRow ? JSON.stringify(firstRow) : ''
      results.push({
        ...q,
        sql: finalSql,
        executed: true,
        rowCount: exec.rowCount,
        keywordHits,
        keywordTotal: q.expectedKeywords?.length ?? 0,
        rowCountMatch: q.expectedRowCount === undefined ? undefined : exec.rowCount === q.expectedRowCount,
        firstRowMatch: q.expectedFirstRowContains === undefined ? undefined : firstRowStr.toLowerCase().includes(q.expectedFirstRowContains.toLowerCase()),
        latencyMs: Date.now() - t0,
      })
    } catch (e) {
      results.push({ ...q, executed: false, error: e instanceof Error ? e.message : String(e), keywordHits: 0, keywordTotal: q.expectedKeywords?.length ?? 0, latencyMs: Date.now() - t0 })
    }
  }

  // Aggregate
  const total = results.length
  const executed = results.filter((r) => r.executed).length
  const keywordChecks = results.filter((r) => r.keywordTotal > 0)
  const keywordPassed = keywordChecks.filter((r) => r.keywordHits >= r.keywordTotal).length
  const rowCountChecks = results.filter((r) => r.rowCountMatch !== undefined)
  const rowCountPassed = rowCountChecks.filter((r) => r.rowCountMatch).length
  const firstRowChecks = results.filter((r) => r.firstRowMatch !== undefined)
  const firstRowPassed = firstRowChecks.filter((r) => r.firstRowMatch).length

  const summary = {
    integration: integration.name,
    provider: integration.provider,
    total,
    executionAccuracy: total ? executed / total : 0,
    keywordAccuracy: keywordChecks.length ? keywordPassed / keywordChecks.length : null,
    rowCountAccuracy: rowCountChecks.length ? rowCountPassed / rowCountChecks.length : null,
    firstRowAccuracy: firstRowChecks.length ? firstRowPassed / firstRowChecks.length : null,
    avgLatencyMs: total ? results.reduce((a, r) => a + r.latencyMs, 0) / total : 0,
  }

  console.log('\n=== Text-to-SQL Evaluation ===')
  for (const r of results) {
    const status = r.executed ? 'PASS' : 'FAIL'
    const kw = r.keywordTotal > 0 ? ` keywords ${r.keywordHits}/${r.keywordTotal}` : ''
    console.log(`[${status}] ${r.id} (${r.latencyMs}ms)${kw}${r.error ? ` — ${r.error.slice(0, 120)}` : ''}`)
    if (r.sql) console.log(`        ${r.sql.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
  console.log('\nSummary:', JSON.stringify(summary, null, 2))

  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify({ summary, results }, null, 2))
    console.log(`\nResults written to ${opts.out}`)
  }
}

main().catch((e) => {
  console.error('sql-eval failed:', e)
  process.exit(1)
})
