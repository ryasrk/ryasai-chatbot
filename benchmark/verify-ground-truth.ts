/**
 * Ground Truth SQL Verifier — runs all benchmark groundTruthSql against the DB
 * to verify the expected results are correct (without using the LLM).
 *
 * Usage: bun run benchmark/verify-ground-truth.ts [--db chinook] [--limit 50]
 */
import { connectorRegistry } from '@/lib/connectors'
import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'
import type { BenchmarkQuestion } from './types'

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

const args = process.argv.slice(2)
const dbFilter = args.find((a) => a.startsWith('--db='))?.split('=')[1]
const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1]
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
if (limit) questions = questions.slice(0, limit)

const connectorCache = new Map<string, any>()

async function getConnector(integrationId: string) {
  if (connectorCache.has(integrationId)) return connectorCache.get(integrationId)!
  const integration = await db.integration.findUnique({ where: { id: integrationId } })
  if (!integration) throw new Error(`Integration ${integrationId} not found`)
  const config = decryptConfig(integration.encryptedConfig)
  const connector = connectorRegistry.getConnector(integrationId, integration.provider, config)
  connectorCache.set(integrationId, connector)
  return connector
}

async function main() {
  console.log(`\nVerifying ${questions.length} ground truth SQL queries...\n`)

  let passed = 0
  let failed = 0
  const failures: { id: string; error: string; sql: string }[] = []

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    process.stdout.write(`[${i + 1}/${questions.length}] ${q.id}... `)

    try {
      const connector = await getConnector(q.integrationId)

      // Validate ground truth SQL with guardrails
      const validation = validateAndSanitizeLlmSql(q.groundTruthSql)
      if (!validation.ok) {
        failed++
        failures.push({ id: q.id, error: `Guardrail: ${validation.reason}`, sql: q.groundTruthSql })
        console.log(`❌ guardrail rejected`)
        continue
      }

      // Execute
      const result = await connector.executeQuery(validation.sanitized ?? q.groundTruthSql)

      // Check expected columns
      if (q.expectedColumns.length > 0 && result.rowCount > 0) {
        const resultCols = Object.keys(result.rows[0]).map((c) => c.toLowerCase())
        const missing = q.expectedColumns.filter((c) => !resultCols.includes(c.toLowerCase()))
        if (missing.length > 0) {
          failed++
          failures.push({ id: q.id, error: `Missing columns: ${missing.join(', ')}`, sql: q.groundTruthSql })
          console.log(`❌ missing columns: ${missing.join(', ')}`)
          continue
        }
      }

      // Check expected answer contains
      if (q.expectedAnswerContains.length > 0) {
        const answerText = JSON.stringify(result.rows).toLowerCase()
        const missing = q.expectedAnswerContains.filter((c) => !answerText.includes(c.toLowerCase()))
        if (missing.length > 0) {
          failed++
          failures.push({ id: q.id, error: `Missing expected values: ${missing.join(', ')}`, sql: q.groundTruthSql })
          console.log(`❌ missing values: ${missing.join(', ')}`)
          continue
        }
      }

      passed++
      console.log(`✅ ${result.rowCount} rows`)
    } catch (e) {
      failed++
      const err = e instanceof Error ? e.message : String(e)
      failures.push({ id: q.id, error: err, sql: q.groundTruthSql })
      console.log(`❌ ${err.slice(0, 80)}`)
    }
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  GROUND TRUTH VERIFICATION RESULTS`)
  console.log(`${'═'.repeat(60)}`)
  console.log(`Total:  ${questions.length}`)
  console.log(`Passed: ${passed} (${((passed / questions.length) * 100).toFixed(1)}%)`)
  console.log(`Failed: ${failed}`)

  if (failures.length > 0) {
    const fs = await import('fs')
    fs.mkdirSync('benchmark/results', { recursive: true })
    fs.writeFileSync('benchmark/results/ground-truth-failures.json', JSON.stringify(failures, null, 2))
    console.log(`\nFailures saved to benchmark/results/ground-truth-failures.json`)
    console.log(`\nFirst 10 failures:`)
    for (const f of failures.slice(0, 10)) {
      console.log(`  ${f.id}: ${f.error.slice(0, 60)}`)
    }
  }
}

main().catch(console.error)
