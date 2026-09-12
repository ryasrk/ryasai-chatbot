/**
 * Database-knowledge + agentic trial.
 *
 * DB knowledge = does `generateSql` receive a faithful schema description, and
 * does generated SQL survive the guardrail and execute against real Postgres?
 * The SQL TEXT here is produced by the mock LLM, so this measures the WIRING
 * (schema in, guarded SQL out, rows back), not SQL quality.
 */
import { db } from '../src/lib/db'
import { connectorRegistry } from '../src/lib/connectors'
import { describeSchema } from '../src/lib/connectors'
import { validateAndSanitizeLlmSql } from '../src/lib/guardrails'
import { hr } from './lib'

const PG = {
  provider: 'POSTGRESQL' as const,
  config: {
    host: 'localhost', port: 5432, database: 'ryasai_dev_trial',
    user: 'ryasai', password: 'ryasai_dev',
  },
}

async function main() {
  hr('DATABASE KNOWLEDGE + AGENTIC WIRING')

  // ---- 1. connector reflection against the real dev DB ----
  hr('1. SCHEMA REFLECTION (real live Postgres)')
  const conn = connectorRegistry.getConnector("trial-conn", "POSTGRESQL", {
    host: 'localhost', port: 5432, database: 'ryasai',
    user: 'ryasai', password: 'ryasai_dev',
  } as never)
  const tables = await conn.fetchSchema()
  console.log(`reflected ${tables.length} tables from the live database`)
  const sample = tables.slice(0, 4).map((t) => `${t.tableName}(${t.columns.length} cols)`)
  console.log(`sample: ${sample.join(', ')}`)

  // ---- 2. describeSchema feeds the SQL prompt ----
  hr('2. SCHEMA DESCRIPTION (what the SQL prompt sees)')
  const desc = describeSchema(tables.slice(0, 3))
  const hasCols = /columns|integer|text|character/i.test(desc)
  console.log(`description length: ${desc.length} chars`)
  console.log(`contains column types: ${hasCols ? 'yes' : 'NO — the prompt would be blind'}`)
  console.log(`first 220 chars:\n${desc.slice(0, 220)}`)

  // ---- 3. guardrail then execute, against real Postgres ----
  hr('3. GUARD + EXECUTE ROUND-TRIP (real Postgres)')
  const attempts: Array<[string, string]> = [
    ['benign select', 'SELECT count(*) AS n FROM "Organization"'],
    ['benign with limit', 'SELECT id FROM "Organization" LIMIT 5'],
    ['dangerous read', "SELECT pg_read_file('/etc/passwd')"],
    ['write attempt', 'DELETE FROM "Document"'],
  ]
  for (const [name, sql] of attempts) {
    const g = validateAndSanitizeLlmSql(sql)
    if (!g.ok) {
      console.log(`${name.padEnd(20)} BLOCKED by guardrail :: ${g.reason}`)
      continue
    }
    try {
      const rows = await conn.executeQuery(g.sanitized)
      console.log(`${name.padEnd(20)} allowed, returned ${rows.rows.length} row(s)`)
    } catch (e) {
      console.log(`${name.padEnd(20)} allowed but DB rejected: ${(e as Error).message.slice(0, 70)}`)
    }
  }

  // ---- 4. DB-layer read-only actually rejects writes ----
  hr('4. DB-LAYER READ-ONLY (second line of defence)')
  try {
    await conn.executeQuery('DELETE FROM "Document"')
    console.log('DELETE succeeded — READ-ONLY MODE NOT ENFORCED (FAIL)')
  } catch (e) {
    console.log(`DELETE rejected by the DB layer: ${(e as Error).message.slice(0, 90)}`)
  }

  connectorRegistry.drop('trial-conn')
  hr('DONE')
  process.exit(0)
}

main().catch((e) => { console.error('TRIAL FAILED:', e); process.exit(1) })
