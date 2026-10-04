/**
 * The two chat transports must have IDENTICAL SQL side effects.
 *
 * WHY THIS IS A BEHAVIOURAL TEST. The repo recorded the same drift class repeatedly — businessContext, the cross-source
 * note, the query scope, the rate limit and the GUARDRAIL_BLOCK audit each reached one transport and not the other —
 * and the guards that followed asserted SOURCE TEXT in one file at a time. Here the same scripted turn is driven
 * through `runSqlBranch` (non-streaming) and `prepareSqlStream` (streaming) and everything that leaves the pipeline is
 * compared: the SQL that ran, what was audited, what was written to queryHistory and what the generator was told.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

type Script = Array<{ sql: string; explanation?: string } | Error>

let generateSqlResults: Script = []
let generateSqlCalls: Array<Record<string, unknown>> = []
let connectorErrors: Error[] = []
let executedSql: string[] = []
let auditRows: Array<{ action: string; severity: string; userId: string }> = []
let queryHistoryRows: Array<{ success: boolean; generatedSql: string }> = []
let rateLimitAllowed = true
let userRole = 'admin'
let accessMode = 'open'
let policyRows: Array<{ tableName: string; allowedColumns: string | null }> = []
let describedTables: string[][] = []

const INTEGRATION = {
  id: 'int-1',
  name: 'Sales',
  provider: 'POSTGRESQL',
  status: 'active',
  encryptedConfig: 'x',
  businessContext: 'Orders are invoiced monthly.',
  contextPrompt: 'Fiscal year starts in April.',
  get accessMode() { return accessMode },
  schemas: [
    { tableName: 'orders', columns: '[{"name":"total","type":"int"},{"name":"note","type":"text"}]', rowCount: 3, sampleRow: null, description: null },
    { tableName: 'payroll', columns: '[{"name":"salary","type":"int"}]', rowCount: 3, sampleRow: '{"salary":25000000}', description: null },
  ],
}

mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'org-a',
  requireOrgContext: () => 'org-a',
  enterWithOrg: () => undefined,
  bypassOrg: async (fn: () => unknown) => fn(),
}))

mock.module('@/lib/db', () => ({
  db: {
    integration: {
      findFirst: async () => INTEGRATION,
      findMany: async () => [{ name: INTEGRATION.name }],
      count: async () => 1,
    },
    auditLog: {
      create: async (q: { data: { action: string; severity: string; userId: string } }) => {
        auditRows.push({ action: q.data.action, severity: q.data.severity, userId: q.data.userId })
        return { id: 'a' }
      },
    },
    queryHistory: {
      create: async (q: { data: { success: boolean; generatedSql: string } }) => {
        queryHistoryRows.push({ success: q.data.success, generatedSql: q.data.generatedSql })
        return { id: 'q' }
      },
    },
    appConfig: { findFirst: async () => null },
    user: { findFirst: async () => ({ role: userRole }) },
    dataAccessPolicy: { findMany: async () => policyRows },
    document: { count: async () => 0, findMany: async () => [] },
  },
}))

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
  log: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
  logSwallowed: () => {},
}))

// Spread the real module: transitive importers need its other exports; only the config decryption is stubbed.
const realCrypto = await import('@/lib/crypto')
mock.module('@/lib/crypto', () => ({ ...realCrypto, decryptConfig: () => ({}) }))

const realConnectors = await import('@/lib/connectors')
mock.module('@/lib/connectors', () => ({
  ...realConnectors,
  connectorRegistry: {
    getConnector: () => ({
      executeQuery: async (sql: string) => {
        executedSql.push(sql)
        const next = connectorErrors.shift()
        if (next) throw next
        return { rows: [{ total: 42 }], rowCount: 1, executionMs: 3 }
      },
      close: async () => {},
    }),
  },
  describeSchema: (tables: Array<{ tableName: string; columns: Array<{ name: string }> }>) => {
    describedTables.push(tables.map((t) => `${t.tableName}(${t.columns.map((c) => c.name).join(',')})`))
    return 'TABLE orders(total int, note text)'
  },
}))

async function* gen(text: string): AsyncGenerator<string, void, unknown> {
  yield text
}

const realAi = await import('@/lib/ai')
mock.module('@/lib/ai', () => ({
  ...realAi,
  generateSql: async (args: Record<string, unknown>) => {
    generateSqlCalls.push(args)
    const next = generateSqlResults.shift()
    if (!next) throw new Error('no scripted generateSql result')
    if (next instanceof Error) throw next
    return next
  },
  generateAnswer: async () => 'answer',
  generateChat: async () => 'chat',
  generateRestCall: async () => ({ endpointId: null }),
  streamAnswer: () => gen('answer'),
  streamChat: () => gen('chat'),
}))

const realSmartRouter = await import('@/lib/smart-router')
mock.module('@/lib/smart-router', () => ({ ...realSmartRouter, resolveIntegrationForQuestion: async () => null }))

mock.module('@/lib/tool-rate-limit', () => ({
  checkToolRateLimit: async () => ({ allowed: rateLimitAllowed, remaining: rateLimitAllowed ? 9 : 0 }),
}))

const realGuardrails = await import('@/lib/guardrails')
mock.module('@/lib/guardrails', () => realGuardrails)

const { runSqlBranch } = await import('@/lib/tool-branches')
const { prepareSqlStream } = await import('@/lib/stream-preparers')

beforeEach(() => {
  generateSqlResults = []
  generateSqlCalls = []
  connectorErrors = []
  executedSql = []
  auditRows = []
  queryHistoryRows = []
  rateLimitAllowed = true
  userRole = 'admin'
  accessMode = 'open'
  policyRows = []
  describedTables = []
})

/** Everything observable that the pipeline produced for one turn. */
function snapshot() {
  return {
    executedSql: [...executedSql],
    describedTables: describedTables.map((t) => [...t]),
    auditRows: auditRows.map((r) => ({ ...r })),
    queryHistoryRows: queryHistoryRows.map((r) => ({ ...r })),
    generatorSaw: generateSqlCalls.map((c) => ({
      systemPromptPrefix: c.systemPromptPrefix,
      businessContext: c.businessContext,
      textColumns: c.textColumns,
      repairFeedback: c.repairFeedback,
    })),
  }
}

async function runBoth(script: () => void, failures: () => void = () => {}) {
  script(); failures()
  const branch = await runSqlBranch({ question: 'total orders', userId: 'u1', integrationId: 'int-1' })
  const viaBranch = snapshot()
  beforeEachReset()
  script(); failures()
  const stream = await prepareSqlStream({
    question: 'total orders',
    userId: 'u1',
    integrationId: 'int-1',
    relevanceJudge: async () => true,
  })
  const viaStream = snapshot()
  return { branch, stream, viaBranch, viaStream }
}

function beforeEachReset() {
  describedTables = []
  generateSqlCalls = []
  executedSql = []
  auditRows = []
  queryHistoryRows = []
}

describe('runSqlBranch and prepareSqlStream have identical SQL side effects', () => {
  test('success after a guardrail rejection and a failed execution', async () => {
    const { branch, stream, viaBranch, viaStream } = await runBoth(
      () => {
        generateSqlResults = [
          { sql: 'DELETE FROM orders' },
          { sql: 'SELECT nope FROM orders LIMIT 10' },
          { sql: 'SELECT total FROM orders LIMIT 10', explanation: 'all statuses' },
        ]
      },
      () => { connectorErrors = [new Error('column "nope" does not exist')] },
    )
    expect(viaStream).toEqual(viaBranch)
    expect(viaBranch.auditRows.map((r) => `${r.action}:${r.severity}`)).toEqual([
      'GUARDRAIL_BLOCK:critical',
      'SQL_EXECUTE_ERROR:warning',
      'SQL_EXECUTE:info',
    ])
    expect(viaBranch.queryHistoryRows.map((r) => r.success)).toEqual([false, true])
    // The admin-authored context reaches generation on BOTH transports.
    expect(String(viaBranch.generatorSaw[0].systemPromptPrefix)).toContain('Fiscal year starts in April.')
    expect(viaBranch.generatorSaw[0].businessContext).toBe('Orders are invoiced monthly.')
    expect(viaBranch.generatorSaw[0].textColumns).toEqual(['note'])
    expect(branch.toolRuns[0].status).toBe('success')
    expect(stream.toolRuns[0].status).toBe('success')
    expect(branch.citations).toEqual(stream.citations)
  })

  test('a provider failure during generation is retried on both transports', async () => {
    const { branch, stream, viaBranch, viaStream } = await runBoth(() => {
      generateSqlResults = [new Error('provider 503'), { sql: 'SELECT total FROM orders LIMIT 10' }]
    })
    expect(viaStream).toEqual(viaBranch)
    expect(String(viaBranch.generatorSaw[1].repairFeedback)).toContain('provider 503')
    expect(branch.toolRuns[0].status).toBe('success')
    expect(stream.toolRuns[0].status).toBe('success')
  })

  test('the SQL rate limit blocks both transports before any generation', async () => {
    rateLimitAllowed = false
    const { branch, stream, viaBranch, viaStream } = await runBoth(() => {
      generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    })
    expect(viaStream).toEqual(viaBranch)
    expect(viaBranch.generatorSaw).toEqual([])
    expect(branch.toolRuns[0].status).toBe('blocked')
    expect(stream.toolRuns[0].status).toBe('blocked')
  })
})

describe('per-role access is enforced identically on both transports', () => {
  test('a viewer on a restricted integration sees only granted columns, and a query outside the grant is denied', async () => {
    userRole = 'viewer'
    accessMode = 'restricted'
    policyRows = [{ tableName: 'orders', allowedColumns: '["total"]' }]
    const { branch, stream, viaBranch, viaStream } = await runBoth(() => {
      generateSqlResults = [
        { sql: 'SELECT salary FROM payroll LIMIT 10' }, // ungranted table
        { sql: 'SELECT note FROM orders LIMIT 10' }, // ungranted column
        { sql: 'SELECT total FROM orders LIMIT 10' },
      ]
    })
    expect(viaStream).toEqual(viaBranch)
    // The generator never saw payroll or the note column — nor the payroll sample value.
    expect(viaBranch.describedTables[0]).toEqual(['orders(total)'])
    expect(viaBranch.auditRows.map((r) => `${r.action}:${r.severity}`)).toEqual([
      'ACCESS_DENIED:critical',
      'ACCESS_DENIED:critical',
      'SQL_EXECUTE:info',
    ])
    expect(viaBranch.executedSql).toEqual(['SELECT total FROM orders LIMIT 10;'])
    expect(branch.toolRuns[0].status).toBe('success')
    expect(stream.toolRuns[0].status).toBe('success')
  })

  test('a role with NO grant in the integration is refused before any generation', async () => {
    userRole = 'analyst'
    accessMode = 'restricted'
    policyRows = []
    const { branch, stream, viaBranch, viaStream } = await runBoth(() => {
      generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    })
    expect(viaStream).toEqual(viaBranch)
    expect(viaBranch.generatorSaw).toEqual([])
    expect(viaBranch.auditRows.map((r) => r.action)).toEqual(['ACCESS_DENIED'])
    expect(branch.toolRuns[0].status).toBe('blocked')
    expect(stream.toolRuns[0].status).toBe('blocked')
    expect(branch.answer).toContain('does not have access')
  })

  test('an admin is never restricted, even on a restricted integration', async () => {
    userRole = 'admin'
    accessMode = 'restricted'
    policyRows = []
    const { viaBranch } = await runBoth(() => {
      generateSqlResults = [{ sql: 'SELECT salary FROM payroll LIMIT 10' }]
    })
    expect(viaBranch.describedTables[0]).toEqual(['orders(total,note)', 'payroll(salary)'])
    expect(viaBranch.executedSql).toEqual(['SELECT salary FROM payroll LIMIT 10;'])
  })

  test('open mode keeps the pre-existing behaviour for every role', async () => {
    userRole = 'viewer'
    accessMode = 'open'
    const { viaBranch } = await runBoth(() => {
      generateSqlResults = [{ sql: 'SELECT salary FROM payroll LIMIT 10' }]
    })
    expect(viaBranch.executedSql).toEqual(['SELECT salary FROM payroll LIMIT 10;'])
  })
})
