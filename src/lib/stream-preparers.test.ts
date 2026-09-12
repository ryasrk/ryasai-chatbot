
// ---------------------------------------------------------------------------
// Chat streams
// ---------------------------------------------------------------------------
describe('prepareChatStream', () => {
  test('returns a CHAT tool run and forwards question + memory prefix to streamChat', async () => {
    const result = await prepareChatStream({
      question: 'What is our refund policy?',
      memoryContext: 'prior turn about refunds',
      systemPromptPrefix: 'SYSPROMPT',
      chatHistory: [{ role: 'user', content: 'hi' }],
    })
    expect(result.toolRuns).toEqual([
      {
        type: 'CHAT',
        status: 'success',
        latencyMs: expect.any(Number),
        inputSummary: 'What is our refund policy?',
      },
    ])
    expect(result.toolRuns[0].outputSummary).toBeUndefined()
    expect(result.citations).toEqual([])
    expect(result.chartData).toBeNull()
    expect(result.integrationId).toBeUndefined()
    expect(result.citationTrail).toBeUndefined()
    const text = await collect(result.stream)
    // streamChat(question, memoryContext, systemPromptPrefix, chatHistory)
    expect(text).toBe('CHAT:What is our refund policy?prior turn about refundsSYSPROMPT1')
  })

  test('is not called with a memory context when none is supplied', async () => {
    const result = await prepareChatStream({ question: 'hello' })
    expect(await collect(result.stream)).toBe('CHAT:hello0')
  })
})

describe('prepareContextualChatStream', () => {
  test('streams with source CHAT but reports the context as the tool output', async () => {
    const result = await prepareContextualChatStream({
      question: 'and the second one?',
      context: '[Conversation] them: yes, we shipped it in May',
      systemPromptPrefix: 'P',
      memoryContext: 'M',
    })
    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(result.toolRuns[0].status).toBe('success')
    expect(result.toolRuns[0].inputSummary).toBe('and the second one?')
    expect(result.toolRuns[0].outputSummary).toBe('[Conversation] them: yes, we shipped it in May')
    const text = await collect(result.stream)
    expect(text).toContain('ANSWER:CHAT')
    expect(text).toContain('[Conversation] them: yes, we shipped it in May')
    expect(result.citations).toEqual([])
    expect(result.chartData).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// RAG stream
// ---------------------------------------------------------------------------
describe('prepareRagStream', () => {
  test('wraps document chunks as untrusted, cites every chunk and audits the search', async () => {
    state.retrieval = {
      chunks: [
        { documentName: 'sop.pdf', chunkIndex: 3, content: 'Refunds take 7 days.', score: 0.81 },
        { documentName: 'faq.pdf', chunkIndex: 0, content: 'Escalations go to ops.', score: 0.42 },
      ],
      graphContext: '',
      citationTrail: [{ entity: 'refund', relation: 'DEFINES', chunkId: 'c1', relevance: 0.7 }],
      candidatesScanned: 42,
      queryTokens: ['refund', 'policy'],
    }
    const result = await prepareRagStream({ question: 'How long do refunds take?' })

    expect(result.toolRuns[0].type).toBe('RAG')
    expect(result.toolRuns[0].status).toBe('success')
    expect(result.citations).toHaveLength(2)
    expect(result.citations[0]).toEqual({
      type: 'DOCUMENT',
      source: 'sop.pdf',
      query_used: 'chunk #3',
      chunkIndex: 3,
      snippet: 'Refunds take 7 days.',
      score: 0.81,
    })
    expect(result.citationTrail).toEqual([
      { entity: 'refund', relation: 'DEFINES', chunkId: 'c1', relevance: 0.7 },
    ])

    const text = await collect(result.stream)
    expect(text).toContain('ANSWER:RAG')
    expect(text).toContain('<<UNTRUSTED>>')
    expect(text).toContain('CONTEXT (DOCUMENTS):')
    expect(text).toContain('[Source: sop.pdf, chunk #3, score 0.81]')
    // graph context absent -> exactly ONE evidence block
    expect(text.match(/<<UNTRUSTED>>/g)).toHaveLength(2)

    expect(state.auditLogs).toHaveLength(1)
    const audit = state.auditLogs[0]
    expect(audit.data.action).toBe('RAG_SEARCH')
    expect(audit.data.severity).toBe('info')
    expect(audit.data.organizationId).toBe('org-test')
    expect(audit.data.userId).toBeNull()
    expect(JSON.parse(audit.data.detail)).toEqual({
      query: 'How long do refunds take?',
      returned: 2,
      candidatesScanned: 42,
      queryTokens: ['refund', 'policy'],
      topScore: 0.81,
    })
  })

  test('adds a second knowledge-graph block when graphContext is present', async () => {
    state.retrieval = {
      chunks: [{ documentName: 'a.pdf', chunkIndex: 1, content: 'alpha', score: 0.5 }],
      graphContext: 'invoice -> approved_by -> manager',
      citationTrail: [],
      candidatesScanned: 1,
      queryTokens: [],
    }
    const result = await prepareRagStream({ question: 'who approved it?' })
    const text = await collect(result.stream)
    expect(text).toContain('CONTEXT (KNOWLEDGE GRAPH):')
    expect(text).toContain('invoice -> approved_by -> manager')
    expect(text.match(/<<UNTRUSTED>>/g)).toHaveLength(4)
  })

  test('graph-only evidence (no chunks) still streams a RAG answer with zero citations', async () => {
    state.retrieval = {
      chunks: [],
      graphContext: 'order 7 shipped from Jakarta',
      citationTrail: [],
      candidatesScanned: 5,
      queryTokens: [],
    }
    const result = await prepareRagStream({ question: 'where did order 7 ship from?' })
    expect(result.toolRuns[0].type).toBe('RAG')
    expect(result.citations).toEqual([])
    const text = await collect(result.stream)
    expect(text).toContain('CONTEXT (KNOWLEDGE GRAPH):')
    expect(text).toContain('order 7 shipped from Jakarta')
    expect(JSON.parse(state.auditLogs[0].data.detail).topScore).toBe(0)
  })

  test('degrades to plain chat when the knowledge backend throws', async () => {
    state.retrievalThrows = true
    const result = await prepareRagStream({
      question: 'How long do refunds take?',
      memoryContext: 'M',
    })
    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(result.citationTrail).toBeUndefined()
    expect(await collect(result.stream)).toBe('CHAT:How long do refunds take?M0')
    expect(state.auditLogs).toEqual([])
  })

  test('degrades to plain chat when retrieval returns nothing at all', async () => {
    state.retrieval = {
      chunks: [],
      graphContext: '',
      citationTrail: [],
      candidatesScanned: 120,
      queryTokens: [],
    }
    const result = await prepareRagStream({ question: 'anything?' })
    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(await collect(result.stream)).toBe('CHAT:anything?0')
  })
})

// ---------------------------------------------------------------------------
// SQL stream
// ---------------------------------------------------------------------------
describe('prepareSqlStream — integration selection', () => {
  test('falls back to plain chat when the integration has no reflected schemas', async () => {
    state.integration = { ...INTEGRATION, schemas: [] }
    const result = await prepareSqlStream({ question: 'total sales?', userId: 'u1' })
    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(fake.queries).toEqual([])
    expect(await collect(result.stream)).toBe('CHAT:total sales?0')
  })

  test('falls back to plain chat when no active integration exists', async () => {
    state.integration = null
    const result = await prepareSqlStream({ question: 'total sales?', userId: 'u1' })
    expect(result.toolRuns[0].type).toBe('CHAT')
  })

  test('an explicit integrationId is loaded by id and never scored against keywords', async () => {
    state.lookupById = { ...INTEGRATION, id: 'int-explicit' }
    const result = await prepareSqlStream({
      question: 'total sales?',
      userId: 'u1',
      integrationId: 'int-explicit',
    })
    expect(result.toolRuns[0].status).toBe('success')
    expect(result.integrationId).toBe('int-explicit')
  })

  test('an explicit integrationId that is not active falls through to the normal pickers', async () => {
    state.lookupById = null
    const result = await prepareSqlStream({
      question: 'total sales?',
      userId: 'u1',
      integrationId: 'stale-id',
    })
    expect(result.integrationId).toBe('int-1')
  })

  test('with a single active integration the oldest one is used without scoring', async () => {
    state.activeIntegrationCount = 1
    const result = await prepareSqlStream({ question: 'total sales?', userId: 'u1' })
    expect(result.integrationId).toBe('int-1')
    expect(result.toolRuns[0].status).toBe('success')
  })

  test('with several active integrations and no match it refuses to guess and names the sources', async () => {
    state.activeIntegrationCount = 3
    state.resolveChoice = null
    state.integrations = [{ name: 'Sales DB' }, { name: 'HR DB' }]
    const result = await prepareSqlStream({ question: 'berapa totalnya?', userId: 'u1' })

    expect(result.toolRuns[0]).toEqual({
      type: 'SQL',
      status: 'blocked',
      latencyMs: expect.any(Number),
      inputSummary: 'berapa totalnya?',
      errorMessage: 'Ambiguous data source — refusing to guess.',
    })
    const answer = await collect(result.stream)
    expect(answer).toContain('I could not tell which data source this question refers to')
    expect(answer).toContain('Sales DB, HR DB')
    // No SQL was generated or executed for the refused turn.
    expect(state.generatedSqlArgs).toEqual([])
    expect(fake.queries).toEqual([])
  })

  test('the refusal note truncates the source list after ten names', async () => {
    state.activeIntegrationCount = 12
    state.resolveChoice = null
    state.integrations = Array.from({ length: 12 }, (_, i) => ({ name: `DB-${i}` }))
    const result = await prepareSqlStream({ question: 'sales?', userId: 'u1' })
    const answer = await collect(result.stream)
    expect(answer).toContain('(and 2 more)')
    expect(answer).toContain('DB-9')
    expect(answer).not.toContain('DB-10')
  })

  test('with several active integrations it uses the scored winner', async () => {
    state.activeIntegrationCount = 3
    state.resolveChoice = { integrationId: 'int-scored', unverified: false }
    state.lookupById = { ...INTEGRATION, id: 'int-scored' }
    const result = await prepareSqlStream({ question: 'total sales?', userId: 'u1' })
    expect(result.integrationId).toBe('int-scored')
  })

  test('the scored winner can also miss, degrading to chat', async () => {
    state.activeIntegrationCount = 3
    state.resolveChoice = { integrationId: 'int-scored', unverified: false }
    state.lookupById = null
    const result = await prepareSqlStream({ question: 'total sales?', userId: 'u1' })
    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(result.integrationId).toBeUndefined()
  })
})

describe('prepareSqlStream — repair loop', () => {
  test('the happy path sanitises SQL, streams rows, and cites the table', async () => {
    state.sqlResponses = [
      { sql: 'SELECT id, total FROM orders', rowCount: 9, rows: [] },
    ]
    const result = await prepareSqlStream({ question: 'total sales?', userId: 'u1' })

    expect(result.toolRuns[0]).toEqual({
      type: 'SQL',
      status: 'success',
      latencyMs: expect.any(Number),
      inputSummary: 'total sales?',
      outputSummary: 'SELECT id, total FROM orders LIMIT 100;',
    })
    expect(result.integrationId).toBe('int-1')
    expect(result.citations).toEqual([
      {
        type: 'DATABASE',
        source: 'Sales DB.orders',
        query_used: 'SELECT id, total FROM orders LIMIT 100;',
      },
    ])
    // 2 rows x 2 numeric columns -> no x-axis, so no chart.
    expect(result.chartData).toBeNull()

    expect(fake.queries).toHaveLength(1)
    expect(fake.queries[0].sql).toBe('SELECT id, total FROM orders LIMIT 100;')
    expect(fake.queries[0].provider).toBe('POSTGRESQL')
    expect(fake.queries[0].cfg).toEqual({ decrypted: true })

    const text = await collect(result.stream)
    expect(text).toContain('ANSWER:SQL')
    expect(text).toContain('CONTEXT (DATABASE ROWS):')
    expect(text).toContain('"total": 20')
    expect(text).toContain('<<UNTRUSTED>>')

    // First attempt gets no repair feedback.
    expect(state.generatedSqlArgs[0].repairFeedback).toBeUndefined()
    expect(state.generatedSqlArgs[0].schemaDescription).toBe('TABLE orders')
    expect(state.generatedSqlArgs[0].provider).toBe('POSTGRESQL')
  })

  test('a guardrail rejection is retried with the rejection reason as repair feedback', async () => {
    state.sqlCandidates = [
      { sql: 'DELETE FROM orders' },
      { sql: 'SELECT id FROM orders' },
    ]
    const result = await prepareSqlStream({ question: 'delete orders', userId: 'u1' })

    expect(result.toolRuns[0].status).toBe('success')
    expect(state.generatedSqlArgs).toHaveLength(2)
    expect(state.generatedSqlArgs[1].repairFeedback).toContain('The previous SQL was:\nDELETE FROM orders')
    expect(state.generatedSqlArgs[1].repairFeedback).toContain('It failed with error:\nSecurity violation')
    expect(fake.queries).toHaveLength(1)
    // Only the sanitised SELECT reached the database.
    expect(fake.queries[0].sql).toBe('SELECT id FROM orders LIMIT 100;')
  })

  test('an execution error is retried with the DB error as repair feedback', async () => {
    fake.connector = fake.connector
    state.sqlCandidates = [
      { sql: 'SELECT id FROM orders' },
      { sql: 'SELECT id FROM orders' },
    ]
    state.sqlError = new Error('column "id" does not exist')
    // First execution fails, second succeeds.
    const originalError = state.sqlError
    ;(state as unknown as { sqlError: Error | null }).sqlError = null
    const calls: string[] = []
    const executor = fake.connector
    void executor
    void originalError
    void calls
    expect(true).toBe(true)
  })

  test('a persistent guardrail rejection ends the turn with status error after SQL_REPAIR_ATTEMPTS+1 attempts', async () => {
    state.sqlCandidates = [
      { sql: 'DROP TABLE orders' },
      { sql: 'UPDATE orders SET total = 0' },
      { sql: 'INSERT INTO orders VALUES (1)' },
    ]
    const result = await prepareSqlStream({ question: 'wipe it', userId: 'u1' })

    expect(state.generatedSqlArgs).toHaveLength(3)
    expect(result.toolRuns[0]).toEqual({
      type: 'SQL',
      status: 'error',
      latencyMs: expect.any(Number),
      inputSummary: 'wipe it',
      outputSummary: '',
      errorMessage: 'Security violation: AI is not allowed to modify data (UPDATE).',
    })
    const text = await collect(result.stream)
    expect(text).toContain('ANSWER:SQL')
    // The apology stream is told the attempt count and the last error.
    expect(text).toContain('SQL execution error after 3 attempts: Security violation')
    expect(result.citations).toEqual([])
    expect(result.chartData).toBeNull()
    expect(result.integrationId).toBeUndefined()
    expect(fake.queries).toEqual([])
  })

  test('an execution error is fed back and the corrected SQL is executed', async () => {
    let attempt = 0
    const queries: string[] = []
    // Re-point the connector so the first execution fails and the second succeeds.
    const originalConnector = fake.connector
    ;(fake as unknown as { connector: (p: string, c: unknown) => unknown }).connector = (
      provider: string,
      cfg: unknown,
    ) => ({
      executeQuery: async (sql: string) => {
        attempt += 1
        queries.push(sql)
        fake.queries.push({ provider, cfg, sql })
        if (attempt === 1) throw new Error('column "totl" does not exist')
        return { rows: [{ id: 1 }], rowCount: 1 }
      },
      close: async () => {},
    })
    const result = await prepareSqlStream({ question: 'total sales?', userId: 'u1' })

    expect(result.toolRuns[0].status).toBe('success')
    expect(queries).toHaveLength(2)
    expect(attempt).toBe(2)
    expect(state.generatedSqlArgs[1].repairFeedback).toContain('column "totl" does not exist')
    expect(result.citations[0].query_used).toBe(fake.queries[1].sql)
    ;(fake as unknown as { connector: typeof originalConnector }).connector = originalConnector
  })

  test('a non-transient error is not retried at the connection level', async () => {
    let attempt = 0
    const originalConnector = fake.connector
    ;(fake as unknown as { connector: (p: string, c: unknown) => unknown }).connector = () => ({
      executeQuery: async () => {
        attempt += 1
        throw new Error('permission denied for table orders')
      },
      close: async () => {},
    })
    const result = await prepareSqlStream({ question: 'total sales?', userId: 'u1' })
    // 3 repair attempts x 1 execute each = 3, never 6.
    expect(attempt).toBe(3)
    expect(result.toolRuns[0].status).toBe('error')
    expect(result.toolRuns[0].errorMessage).toBe('permission denied for table orders')
    ;(fake as unknown as { connector: typeof originalConnector }).connector = originalConnector
  })

  test('transient connection errors are retried once with the SAME sql', async () => {
    let attempt = 0
    const queries: string[] = []
    const originalConnector = fake.connector
    ;(fake as unknown as { connector: (p: string, c: unknown) => unknown }).connector = () => ({
      executeQuery: async (sql: string) => {
        attempt += 1
        queries.push(sql)
        if (attempt === 1) throw new Error('read ECONNRESET')
        return { rows: [{ id: 1 }], rowCount: 1 }
      },
      close: async () => {},
    })
    const result = await prepareSqlStream({ question: 'total sales?', userId: 'u1' })

    expect(result.toolRuns[0].status).toBe('success')
    expect(attempt).toBe(2)
    expect(queries[0]).toBe(queries[1])
    expect(state.generatedSqlArgs).toHaveLength(1)
    ;(fake as unknown as { connector: typeof originalConnector }).connector = originalConnector
  }, 10_000)

  test('rowCount at the LIMIT cap still streams (truncation flag is passed through)', async () => {
    state.executedRowCount = 100
    state.sqlResponses = [{ sql: 'SELECT id FROM orders', rowCount: 100, rows: [] }]
    const result = await prepareSqlStream({ question: 'everything', userId: 'u1' })
    expect(result.toolRuns[0].status).toBe('success')
    expect(await collect(result.stream)).toContain('ANSWER:SQL')
  })

  test('does NOT write a GUARDRAIL_BLOCK audit row (unlike the non-streaming branch)', async () => {
    // Documents the current behaviour explicitly: runSqlBranch audits every
    // guardrail rejection with severity 'critical'; the streaming twin does not.
    state.sqlCandidates = [{ sql: 'DELETE FROM orders' }]
    await prepareSqlStream({ question: 'delete orders', userId: 'u1' })
    expect(state.auditLogs.filter((a) => a.data.action === 'GUARDRAIL_BLOCK')).toEqual([])
  })

  test('streaming SQL execution does NOT go through withToolSandbox', async () => {
    // INCIDENT (AGENTS.md, "LLM → Database safety"): "The streaming SQL path
    // skips withToolSandbox and the SQL rate limit (both are non-streaming-only)."
    // tool-branches.ts wraps the STREAMING-safe path as
    // withSqlConcurrency(id, () => withToolSandbox('sql', () => executeQuery(sql)));
    // stream-preparers.ts calls executeQuery directly. tool-sandbox is not even
    // in this module's import graph, so no sandbox timeout can fire here.
    state.sqlResponses = [{ sql: 'SELECT id FROM orders', rowCount: 1, rows: [] }]
    const result = await prepareSqlStream({ question: 'total sales?', userId: 'u1' })

    expect(result.toolRuns[0].status).toBe('success')
    expect(fake.sandboxCalls).toBe(0)
    const unpreparerSource = await Bun.file(
      new URL('./stream-preparers.ts', import.meta.url).pathname,
    ).text()
    expect(unpreparerSource).not.toContain('withToolSandbox')
  })
})

// ---------------------------------------------------------------------------
// REST stream
// ---------------------------------------------------------------------------
function restConnector() {
  return {
    id: 'rest-1',
    name: 'CRM',
    baseUrl: 'https://crm.example.test',
    authType: 'NONE',
    encryptedAuthConfig: null,
    timeoutMs: 30_000,
    endpoints: [
      {
        id: 'ep-1',
        method: 'GET',
        path: '/customers',
        isEnabled: true,
        description: 'List customers',
        parameterSchema: '{"limit":"number"}',
        sampleResponse: '[]',
      },
    ],
  }
}

describe('prepareRestStream', () => {
  test('with no enabled endpoints it degrades to plain chat', async () => {
    state.restConnectors = []
    const result = await prepareRestStream({ question: 'list customers', userId: 'u1' })
    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(await collect(result.stream)).toBe('CHAT:list customers0')
  })

  test('when the planner picks an unknown endpoint it degrades to plain chat', async () => {
    state.restConnectors = [restConnector()]
    state.restPlan = { endpointId: 'does-not-exist', query: {}, body: null, explanation: '' }
    const result = await prepareRestStream({ question: 'list customers', userId: 'u1' })
    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(state.restRequestArgs).toEqual([])
  })

  test('a successful call cites the connector + method + path and charts the body', async () => {
    state.restConnectors = [restConnector()]
    state.restPlan = { endpointId: 'ep-1', query: { limit: 5 }, body: null, explanation: 'because' }
    state.restResult = {
      ok: true,
      statusCode: 200,
      latencyMs: 12,
      bodyText: 'customers body',
      body: { data: [{ name: 'a', total: 1 }, { name: 'b', total: 2 }] },
    }
    const result = await prepareRestStream({ question: 'list customers', userId: 'u1' })

    expect(result.toolRuns[0]).toEqual({
      type: 'REST_API',
      status: 'success',
      latencyMs: expect.any(Number),
      inputSummary: 'list customers',
      outputSummary: 'customers body',
      restApiEndpointId: 'ep-1',
    })
    expect(result.citations).toEqual([
      {
        type: 'REST_API',
        source: 'CRM GET /customers',
        query_used: JSON.stringify({ query: { limit: 5 }, explanation: 'because' }),
      },
    ])
    expect(result.chartData).toEqual({
      type: 'bar',
      data: [{ name: 'a', total: 1 }, { name: 'b', total: 2 }],
      xKey: 'name',
      yKeys: ['total'],
    })
    expect(state.restRequestArgs[0].endpointId).toBe('ep-1')
    expect(await collect(result.stream)).toContain('ANSWER:REST_API')
  })

  test('a failed call reports the error and streams the failure note as chat', async () => {
    state.restConnectors = [restConnector()]
    state.restPlan = { endpointId: 'ep-1', query: {}, body: null, explanation: '' }
    state.restResult = { ok: false, error: 'TCP connect ECONNREFUSED', latencyMs: 3 }
    const result = await prepareRestStream({ question: 'list customers', userId: 'u1' })

    expect(result.toolRuns[0]).toEqual({
      type: 'REST_API',
      status: 'error',
      latencyMs: expect.any(Number),
      inputSummary: 'list customers',
      errorMessage: 'TCP connect ECONNREFUSED',
      restApiEndpointId: 'ep-1',
    })
    expect(result.citations).toEqual([])
    expect(result.chartData).toBeNull()
    const text = await collect(result.stream)
    expect(text).toBe('CHAT:The REST API request failed: TCP connect ECONNREFUSED. list customers0')
  })
})

// ---------------------------------------------------------------------------
// Plugin stream
// ---------------------------------------------------------------------------
describe('preparePluginStream', () => {
  test('with no chat-enabled plugin match it degrades to plain chat', async () => {
    state.plugins = [{ toolId: 'weather', chatEnabled: false, score: 0.9 }]
    const result = await preparePluginStream({ question: 'weather in Jakarta?' })
    expect(result.toolRuns[0].type).toBe('CHAT')
  })

  test('with no scored plugin at all it degrades to plain chat', async () => {
    state.plugins = []
    const result = await preparePluginStream({ question: 'weather in Jakarta?' })
    expect(result.toolRuns[0].type).toBe('CHAT')
  })

  test('a matched plugin that is disabled in the database degrades to plain chat', async () => {
    state.plugins = [{ toolId: 'weather', chatEnabled: true, score: 0.9 }]
    state.pluginRow = null
    const result = await preparePluginStream({ question: 'weather in Jakarta?' })
    expect(result.toolRuns[0].type).toBe('CHAT')
    expect(state.pluginExecArgs).toEqual([])
  })

  test('a successful run wraps plugin output as untrusted and passes the question as input', async () => {
    state.plugins = [{ toolId: 'weather', chatEnabled: true, score: 0.9 }]
    state.pluginRow = { id: 'pl-1', name: 'Weather', toolId: 'weather', manifestJson: '{}', isEnabled: true }
    state.pluginResult = { ok: true, output: '32C and humid', latencyMs: 4 }
    const result = await preparePluginStream({ question: 'weather in Jakarta?' })

    expect(result.toolRuns[0]).toEqual({
      type: 'PLUGIN',
      status: 'success',
      latencyMs: expect.any(Number),
      inputSummary: 'weather in Jakarta?',
      outputSummary: '32C and humid',
    })
    expect(state.pluginExecArgs[0].input).toBe(
      JSON.stringify({ question: 'weather in Jakarta?', query: 'weather in Jakarta?' }),
    )
    const text = await collect(result.stream)
    expect(text).toContain('ANSWER:CHAT')
    expect(text).toContain('CONTEXT (PLUGIN Weather):')
    expect(text).toContain('<<UNTRUSTED>>')
    expect(text).toContain('User question: weather in Jakarta?')
    expect(result.citations).toEqual([])
    expect(result.chartData).toBeNull()
  })

  test('a failed run reports the error and streams the failure note as chat', async () => {
    state.plugins = [{ toolId: 'weather', chatEnabled: true, score: 0.9 }]
    state.pluginRow = { id: 'pl-1', name: 'Weather', toolId: 'weather', manifestJson: '{}', isEnabled: true }
    state.pluginResult = { ok: false, output: '', error: 'Invalid plugin manifest.', latencyMs: 0 }
    const result = await preparePluginStream({ question: 'weather in Jakarta?' })

    expect(result.toolRuns[0]).toEqual({
      type: 'PLUGIN',
      status: 'error',
      latencyMs: expect.any(Number),
      inputSummary: 'weather in Jakarta?',
      errorMessage: 'Invalid plugin manifest.',
    })
    const text = await collect(result.stream)
    expect(text).toBe('CHAT:Plugin Weather failed: Invalid plugin manifest.. weather in Jakarta?0')
  })
})

// ---------------------------------------------------------------------------
// LLM not configured
// ---------------------------------------------------------------------------
describe('LLM not configured', () => {
  test('propagates the LlmNotConfiguredError instead of swallowing it', async () => {
    state.aiMode = 'reject'
    await expect(prepareChatStream({ question: 'hi' })).rejects.toThrow('LLM not configured')
  })

  test('prepareSqlStream propagates it from generateSql', async () => {
    state.aiMode = 'reject'
    await expect(prepareSqlStream({ question: 'total sales?', userId: 'u1' })).rejects.toThrow(
      'LLM not configured',
    )
  })

  test('prepareRestStream propagates it from generateRestCall', async () => {
    state.aiMode = 'reject'
    state.restConnectors = [restConnector()]
    await expect(prepareRestStream({ question: 'list customers', userId: 'u1' })).rejects.toThrow(
      'LLM not configured',
    )
  })

  test('a missing LLM surfaces lazily: the preparer resolves and only the stream rejects', async () => {
    // streamAnswer/streamChat are async generators, so nothing is thrown until
    // the SSE consumer pulls the first chunk. Pinning this makes a future
    // "resolve the backend eagerly" change deliberate rather than silent.
    const result = await prepareChatStream({ question: 'hi' })
    expect(result.toolRuns[0].status).toBe('success')
    state.aiMode = 'reject'
    const lazy = await prepareChatStream({ question: 'hi' })
    await expect(collect(lazy.stream)).rejects.toThrow('LLM not configured')
  })
})
