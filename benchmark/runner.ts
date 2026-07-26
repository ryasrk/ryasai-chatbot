/**
 * Benchmark Runner — executes all benchmark questions through the NL→SQL→Answer pipeline.
 *
 * Usage:
 *   bun run benchmark/runner.ts                    # run all 540 questions
 *   bun run benchmark/runner.ts --db chinook       # run only Chinook (120 questions)
 *   bun run benchmark/runner.ts --limit 50         # run first 50 questions
 *   bun run benchmark/runner.ts --category aggregation  # run only aggregation questions
 *
 * Output: benchmark/results/report.json + console summary
 */
import { connectorRegistry } from '@/lib/connectors'
import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'
import { generateSql } from '@/lib/ai'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'
import type { BenchmarkQuestion } from './types'
import {
  checkAnswerContains,
  checkColumns,
  calculatePartialCredit,
  summarizeResults,
  type BenchmarkResult,
} from './evaluator'

// Load all question sets
import { chinookQuestions } from './questions/chinook'
import { pagilaQuestions } from './questions/pagila'
import { worldQuestions } from './questions/world'
import { erpQuestions } from './questions/erp'
import { clickhouseQuestions } from './questions/clickhouse'

const ALL_QUESTIONS: BenchmarkQuestion[] = [
  ...chinookQuestions,
  ...pagilaQuestions,
  ...worldQuestions,
  ...erpQuestions,
  ...clickhouseQuestions,
]

// Parse CLI args
const args = process.argv.slice(2)
const dbFilter = args.find((a) => a.startsWith('--db='))?.split('=')[1]
const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1]
const categoryFilter = args.find((a) => a.startsWith('--category='))?.split('=')[1]
const limit = limitArg ? parseInt(limitArg, 10) : undefined

let questions = ALL_QUESTIONS
if (dbFilter) {
  const filterMap: Record<string, string> = {
    chinook: 'int-chinook-001',
    pagila: 'int-pagila-001',
    world: 'int-world-001',
    erp: 'int-erp-001',
    clickhouse: 'int-clickhouse-001',
  }
  const intId = filterMap[dbFilter]
  if (intId) questions = questions.filter((q) => q.integrationId === intId)
}
if (categoryFilter) {
  questions = questions.filter((q) => q.category === categoryFilter)
}
if (limit) {
  questions = questions.slice(0, limit)
}

console.log(`\n${'═'.repeat(70)}`)
console.log(`  RAG BENCHMARK RUNNER — ${questions.length} questions`)
console.log(`${'═'.repeat(70)}\n`)

// Cache connectors + schemas
const connectorCache = new Map<string, { connector: any; schemaText: string }>()

async function getConnector(integrationId: string) {
  if (connectorCache.has(integrationId)) return connectorCache.get(integrationId)!

  const integration = await db.integration.findUnique({ where: { id: integrationId } })
  if (!integration) throw new Error(`Integration ${integrationId} not found`)

  const config = decryptConfig(integration.encryptedConfig)
  const connector = connectorRegistry.getConnector(integrationId, integration.provider, config)

  // Load schema for SQL generation prompt
  const schemaRows = await db.integrationSchema.findMany({ where: { integrationId } })
  const schemaText = schemaRows
    .map((r) => {
      const cols = JSON.parse(r.columns as string)
      const colDefs = cols.map((c: any) => `  ${c.name} ${c.type}`).join('\n')
      return `TABLE ${r.tableName} (${r.rowCount} rows):\n${colDefs}`
    })
    .join('\n\n')

  const entry = { connector, schemaText }
  connectorCache.set(integrationId, entry)
  return entry
}

async function runQuestion(q: BenchmarkQuestion): Promise<BenchmarkResult> {
  const start = Date.now()
  const { connector, schemaText } = await getConnector(q.integrationId)

  let generatedSql = ''
  let sqlValid = false
  let sqlExecuted = false
  let sqlError: string | undefined
  let rows: Record<string, unknown>[] = []
  let rowCount = 0

  try {
    // Stage 1: Generate SQL via LLM
    const sqlStart = Date.now()
    const sqlResult = await generateSql({
      question: q.question,
      schemaDescription: schemaText,
      provider: (connector as any).provider,
      dialectHint: (connector as any).provider === 'CLICKHOUSE' ? 'clickhouse' : 'sqlite',
    })
    generatedSql = sqlResult.sql
    const sqlGenMs = Date.now() - sqlStart

    // Stage 2: Validate with guardrails
    const validation = validateAndSanitizeLlmSql(generatedSql)
    if (!validation.ok) {
      sqlError = validation.reason ?? 'Guardrail rejected SQL'
      return {
        questionId: q.id,
        category: q.category,
        difficulty: q.difficulty,
        question: q.question,
        latency: { total: Date.now() - start, sqlGen: sqlGenMs },
        generatedSql,
        sqlValid: false,
        sqlExecuted: false,
        sqlError,
        rowCount: 0,
        rows: [],
        expectedColumnsFound: [],
        expectedColumnsMissing: q.expectedColumns,
        answerContainsAllExpected: false,
        answerMissingExpected: q.expectedAnswerContains,
        correct: false,
        partialCredit: 0,
      }
    }
    sqlValid = true
    const sanitizedSql = validation.sanitized ?? generatedSql

    // Stage 3: Execute SQL
    const execStart = Date.now()
    const result = await connector.executeQuery(sanitizedSql)
    const sqlExecMs = Date.now() - execStart
    sqlExecuted = true
    rows = result.rows as Record<string, unknown>[]
    rowCount = result.rowCount

    // Stage 4: Check correctness
    const resultColumns = rowCount > 0 ? Object.keys(rows[0]) : []
    const { found, missing } = checkColumns(resultColumns, q.expectedColumns)

    // Build answer text from rows for checking
    const answerText = JSON.stringify(rows)
    const { allFound, missing: missingAns } = checkAnswerContains(answerText, q.expectedAnswerContains)

    const partialCredit = calculatePartialCredit({
      sqlValid,
      sqlExecuted,
      expectedColumnsMissing: missing,
      answerContainsAllExpected: allFound,
      expectedAnswerContainsEmpty: q.expectedAnswerContains.length === 0,
    })

    const correct = sqlValid && sqlExecuted && missing.length === 0 && (q.expectedAnswerContains.length === 0 || allFound)

    return {
      questionId: q.id,
      category: q.category,
      difficulty: q.difficulty,
      question: q.question,
      latency: { total: Date.now() - start, sqlGen: sqlGenMs, sqlExec: sqlExecMs },
      generatedSql,
      sqlValid,
      sqlExecuted,
      rowCount,
      rows: rows.slice(0, 5), // keep only first 5 rows for report
      expectedColumnsFound: found,
      expectedColumnsMissing: missing,
      answerContainsAllExpected: allFound,
      answerMissingExpected: missingAns,
      correct,
      partialCredit,
    }
  } catch (e) {
    sqlError = e instanceof Error ? e.message : String(e)
    return {
      questionId: q.id,
      category: q.category,
      difficulty: q.difficulty,
      question: q.question,
      latency: { total: Date.now() - start },
      generatedSql,
      sqlValid,
      sqlExecuted,
      sqlError,
      rowCount: 0,
      rows: [],
      expectedColumnsFound: [],
      expectedColumnsMissing: q.expectedColumns,
      answerContainsAllExpected: false,
      answerMissingExpected: q.expectedAnswerContains,
      correct: false,
      partialCredit: 0,
    }
  }
}

// Run all questions
async function main() {
  const results: BenchmarkResult[] = []
  let passed = 0
  let failed = 0

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    process.stdout.write(`[${i + 1}/${questions.length}] ${q.id} (${q.category})... `)

    const result = await runQuestion(q)
    results.push(result)

    if (result.correct) {
      passed++
      console.log(`✅ ${result.latency.total}ms`)
    } else if (result.partialCredit >= 0.5) {
      console.log(`🟡 partial (${result.partialCredit}) — ${result.sqlError ?? 'wrong values'}`)
    } else {
      failed++
      console.log(`❌ ${result.sqlError ?? 'incorrect'} (${result.latency.total}ms)`)
    }

    // Rate limit — avoid overwhelming the LLM
    if (i < questions.length - 1) {
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  // Generate summary
  const summary = summarizeResults(results, questions)

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  BENCHMARK RESULTS`)
  console.log(`${'═'.repeat(70)}\n`)

  console.log(`Total Questions:  ${summary.totalRun}`)
  console.log(`Passed:           ${summary.passed} (${(summary.passRate * 100).toFixed(1)}%)`)
  console.log(`Failed:           ${summary.failed}`)
  console.log(`Partial:          ${summary.partial}`)
  console.log(`SQL Validity:     ${(summary.sqlValidityRate * 100).toFixed(1)}%`)
  console.log(`Robustness Score: ${(summary.robustnessScore * 100).toFixed(1)}%`)

  console.log(`\nLatency (ms):`)
  console.log(`  P50:  ${summary.latency.p50}`)
  console.log(`  P95:  ${summary.latency.p95}`)
  console.log(`  Avg:  ${summary.latency.avg}`)

  console.log(`\nBy Category:`)
  for (const [cat, stats] of Object.entries(summary.byCategory).sort((a, b) => b[1].passRate - a[1].passRate)) {
    const bar = '█'.repeat(Math.round(stats.passRate * 20))
    console.log(`  ${cat.padEnd(25)} ${bar} ${(stats.passRate * 100).toFixed(0)}% (${stats.passed}/${stats.total})`)
  }

  console.log(`\nBy Difficulty:`)
  for (const [diff, stats] of Object.entries(summary.byDifficulty)) {
    console.log(`  ${diff.padEnd(10)} ${(stats.passRate * 100).toFixed(1)}% (${stats.passed}/${stats.total})`)
  }

  console.log(`\nBy Database:`)
  for (const [intId, stats] of Object.entries(summary.byIntegration)) {
    const name = intId.includes('chinook') ? 'Chinook' : intId.includes('pagila') ? 'Pagila' : intId.includes('world') ? 'World' : intId.includes('erp') ? 'ERP' : intId.includes('clickhouse') ? 'ClickHouse' : intId
    console.log(`  ${name.padEnd(15)} ${(stats.passRate * 100).toFixed(1)}% (${stats.passed}/${stats.total})`)
  }

  // Save full report
  const reportPath = 'benchmark/results/report.json'
  const fs = await import('fs')
  fs.mkdirSync('benchmark/results', { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2))
  console.log(`\nFull report saved to ${reportPath}`)

  // Save failed questions for analysis
  const failedResults = results.filter((r) => !r.correct)
  if (failedResults.length > 0) {
    fs.writeFileSync('benchmark/results/failures.json', JSON.stringify(failedResults, null, 2))
    console.log(`Failed questions saved to benchmark/results/failures.json`)
  }
}

main().catch(console.error)
