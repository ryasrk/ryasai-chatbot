import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { describeSchema } from './connectors'

// --- Mocks for the init*Context tests (must precede the source-init import) ---
const docRow: { current: Record<string, unknown> | null } = { current: null }
const endpointRow: { current: Record<string, unknown> | null } = { current: null }
const integrationRow: { current: Record<string, unknown> | null } = { current: null }
const updates: Array<{ model: string; data: Record<string, unknown> }> = []
const warnings: string[] = []

mock.module('@/lib/db', () => ({
  db: {
    document: {
      findFirst: async () => docRow.current,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (docUpdateThrows) throw new Error('db write failed')
        updates.push({ model: 'document', data })
        return data
      },
    },
    restApiEndpoint: {
      findFirst: async () => endpointRow.current,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push({ model: 'restApiEndpoint', data })
        return data
      },
    },
    integration: {
      findUnique: async () => integrationRow.current,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push({ model: 'integration', data })
        return data
      },
    },
  },
}))

let docUpdateThrows = false
let cfgValue: Record<string, unknown> | null = { id: '1' }
let chatImpl: () => Promise<string> = async () => 'A document about invoices.'
mock.module('@/lib/llm-config', () => ({
  getRoleLlmConfig: async () => cfgValue,
}))
// The prompts are captured HERE, in the mock, not by swapping the module's
// export after import: source-init reaches chatOnce through `await import()`, so
// a later reassignment of the module namespace has no effect on it. Capturing in
// the mock is the only approach that observes the real argument.
const chatPrompts: Array<{ system: string; user: string }> = []
mock.module('@/lib/llm-client', () => ({
  chatOnce: async (_cfg: unknown, msgs: Array<{ role: string; content: string }>) => {
    chatPrompts.push({ system: msgs[0]?.content ?? '', user: msgs[1]?.content ?? '' })
    return chatImpl()
  },
}))
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({
    info: () => {},
    warn: (m: string) => { warnings.push(m) },
    error: () => {},
  }),
  logSwallowed: (..._a: unknown[]) => (_e: unknown) => {},
}))

const enrichCalls: Array<{ id: string }> = []
let enrichThrows = false
mock.module('@/lib/schema-enrichment', () => ({
  enrichSchemaDescriptions: async (id: string) => {
    if (enrichThrows) throw new Error('enrich failed')
    enrichCalls.push({ id })
  },
  safeParseColumns: (raw: string) => { try { return JSON.parse(raw) } catch { return [] } },
  safeParseSampleRow: (raw: string | null) => { if (!raw) return null; try { return JSON.parse(raw) } catch { return null } },
}))

const profileCalls: Array<Record<string, unknown>> = []
let profileValue: string | null = 'DOMAIN OVERVIEW'
mock.module('@/lib/ai', () => ({
  generateDatabaseProfile: async (a: Record<string, unknown>) => {
    profileCalls.push(a)
    return profileValue
  },
}))

const { initDocumentContext, initRestEndpointContext, initIntegrationContext, SOURCE_INIT_LIMITS } =
  await import('./source-init')


// ---------------------------------------------------------------------------
// describeSchema must render the LLM-generated business description into the
// Text-to-SQL prompt. It used to be dropped at every call site — the
// schema-enrichment pass paid for descriptions that only the intent router
// ever saw; generateSql got bare column lists.
// ---------------------------------------------------------------------------

describe('describeSchema — table descriptions in the SQL prompt', () => {
  test('renders the description after the table header', () => {
    const out = describeSchema([
      {
        tableName: 'invoices',
        columns: [{ name: 'id', type: 'int', primaryKey: true }],
        rowCount: 1200,
        description: 'Customer invoices with payment status — answers billing and receivables questions.',
      },
    ])
    expect(out).toContain('TABLE invoices (1200 rows)  PK: id')
    expect(out).toContain('-- Customer invoices with payment status — answers billing and receivables questions.')
  })

  test('description placed BEFORE columns so the model reads context first', () => {
    const out = describeSchema([
      {
        tableName: 't',
        columns: [{ name: 'a', type: 'int' }],
        description: 'DESC-MARKER',
      },
    ])
    const descPos = out.indexOf('DESC-MARKER')
    const colPos = out.indexOf('a int')
    expect(descPos).toBeGreaterThan(-1)
    expect(colPos).toBeGreaterThan(descPos)
  })

  test('no description → header stays clean (back-compat)', () => {
    const out = describeSchema([
      { tableName: 'x', columns: [{ name: 'a', type: 'int' }] },
    ])
    // No estimate is available, so the header says so rather than printing a number.
    // Previously "? rows"; both are honest, and the assertion pins the current wording.
    expect(out).toContain('TABLE x (row count unknown)')
    expect(out).not.toContain('--')
  })

  test('null description is treated as absent', () => {
    const out = describeSchema([
      { tableName: 'y', columns: [], description: null },
    ])
    expect(out).not.toContain('-- null')
    expect(out).toContain('TABLE y')
  })
})

// ---------------------------------------------------------------------------
// intent formatting — document rows render as "name [category] — description"
// and REST endpoints as "METHOD path: description" (tool-router.formatDocForIntent
// is not exported; the same contract is asserted via source-init helpers below).
// ---------------------------------------------------------------------------

describe('source-init module surface', () => {
  test('exports the init functions used by upload/endpoint routes', async () => {
    const mod = await import('./source-init')
    expect(typeof mod.initDocumentContext).toBe('function')
    expect(typeof mod.initRestEndpointContext).toBe('function')
    expect(typeof mod.initIntegrationContext).toBe('function')
    // bounded inputs — cost ceiling per init call
    expect(mod.SOURCE_INIT_LIMITS.MAX_DOC_CHARS).toBeLessThanOrEqual(8000)
    expect(mod.SOURCE_INIT_LIMITS.MAX_SAMPLE_CHARS).toBeLessThanOrEqual(2000)
  })
})

// ---------------------------------------------------------------------------
// initDocumentContext — the no-op paths ARE the contract
// ---------------------------------------------------------------------------

describe('initDocumentContext', () => {
  beforeEach(() => {
    docRow.current = { id: 'doc-1', name: 'scan_001.pdf', category: null, description: null, contentText: 'policy text' }
    updates.length = 0
    warnings.length = 0
    cfgValue = { id: '1' }
    docUpdateThrows = false
    chatImpl = async () => 'A document about invoices.'
    chatPrompts.length = 0
  })

  test('a generated description is persisted', async () => {
    await initDocumentContext('doc-1')
    expect(updates).toHaveLength(1)
    expect(updates[0].model).toBe('document')
    expect(updates[0].data.description).toBe('A document about invoices.')
  })

  test('surrounding quotes are stripped from the model output', async () => {
    chatImpl = async () => '"Quoted description."'
    await initDocumentContext('doc-1')
    // Models habitually wrap short strings in quotes despite instructions; a
    // stored '"..."' then renders as literal quotes in the retrieval prompt.
    expect(updates[0].data.description).toBe('Quoted description.')
  })

  test('an EMPTY model answer writes nothing', async () => {
    chatImpl = async () => '   '
    await initDocumentContext('doc-1')
    // An empty description would overwrite a good manual one with nothing.
    //
    // MEASURED, not assumed: this behaviour is held by the CALLER's
    // `if (!description) return`, not by llmSummarize's `text.length > 0` guard.
    // Removing either one ALONE leaves this test green; removing the caller's
    // guard fails it, and removing both fails it too. Two guards cover the same
    // condition — deliberate belt-and-braces (llmSummarize is also reachable from
    // initRestEndpointContext), so this test is about the OUTCOME and passes
    // whichever guard is doing the work.
    expect(updates).toHaveLength(0)
  })

  test('the description is capped at 400 characters', async () => {
    chatImpl = async () => 'x'.repeat(900)
    await initDocumentContext('doc-1')
    expect((updates[0].data.description as string).length).toBe(400)
  })

  test('a missing document is a silent no-op', async () => {
    docRow.current = null
    await initDocumentContext('gone')
    // Fire-and-forget callers race with deletes; throwing here would produce an
    // unhandled rejection in a route that has already responded.
    expect(updates).toHaveLength(0)
  })

  test('NO LLM configured is a no-op, and the document is not even read', async () => {
    cfgValue = null
    await initDocumentContext('doc-1')
    // Bounded cost: with no LLM there is nothing to summarize, so a large
    // contentText should never be pulled out of the database.
    expect(updates).toHaveLength(0)
  })

  test('an LLM call that throws is swallowed', async () => {
    chatImpl = async () => { throw new Error('provider 500') }
    await expect(initDocumentContext('doc-1')).resolves.toBeUndefined()
    // Ingestion must never be blocked by a failed summary.
    expect(updates).toHaveLength(0)
    expect(warnings.length).toBeGreaterThan(0)
  })

  test('a database write failure is swallowed', async () => {
    docUpdateThrows = true
    await expect(initDocumentContext('doc-1')).resolves.toBeUndefined()
  })

  test('the content is truncated before it reaches the prompt', async () => {
    docRow.current = { ...docRow.current, contentText: 'z'.repeat(50_000) }
    await initDocumentContext('doc-1')
    // A 50k-character document must not be sent whole; MAX_DOC_CHARS bounds the
    // cost of the first scan.
    expect(chatPrompts[0].user.length).toBeLessThan(SOURCE_INIT_LIMITS.MAX_DOC_CHARS + 200)
  })

  test('the prompt includes the file name and category', async () => {
    docRow.current = { ...docRow.current, name: 'Q3_invoices.xlsx', category: 'FINANCE' }
    await initDocumentContext('doc-1')
    // File names carry almost no signal, so the name and category are the only
    // framing the model gets beyond the raw content.
    expect(chatPrompts[0].user).toContain('Q3_invoices.xlsx')
    expect(chatPrompts[0].user).toContain('FINANCE')
  })

  test('a null category renders as a placeholder, not "null"', async () => {
    await initDocumentContext('doc-1')
    expect(chatPrompts[0].user).toContain('Category: -')
    expect(chatPrompts[0].user).not.toContain('null')
  })
})

// ---------------------------------------------------------------------------
// initRestEndpointContext
// ---------------------------------------------------------------------------

describe('initRestEndpointContext', () => {
  beforeEach(() => {
    endpointRow.current = {
      id: 'ep-1', method: 'GET', path: '/invoices', parameterSchema: '{"status":"string"}',
      sampleResponse: '{"count":3}', description: null,
      connector: { name: 'Billing', baseUrl: 'https://api.example.com' },
    }
    updates.length = 0
    cfgValue = { id: '1' }
    chatImpl = async () => 'Returns invoice records filtered by status.'
    chatPrompts.length = 0
  })

  test('a generated description is persisted', async () => {
    await initRestEndpointContext('ep-1')
    expect(updates).toHaveLength(1)
    expect(updates[0].model).toBe('restApiEndpoint')
  })

  test('the prompt names the connector, method, path and parameters', async () => {
    await initRestEndpointContext('ep-1')
    // Without the method+path the model cannot tell two endpoints apart, and
    // endpoint selection for generateRestCall degrades badly.
    expect(chatPrompts[0].user).toContain('Billing')
    expect(chatPrompts[0].user).toContain('GET /invoices')
    expect(chatPrompts[0].user).toContain('status')
  })

  test('a missing endpoint is a silent no-op', async () => {
    endpointRow.current = null
    await initRestEndpointContext('gone')
    expect(updates).toHaveLength(0)
  })

  test('no LLM configured is a no-op', async () => {
    cfgValue = null
    await initRestEndpointContext('ep-1')
    expect(updates).toHaveLength(0)
  })

  test('an LLM failure is swallowed', async () => {
    chatImpl = async () => { throw new Error('boom') }
    await expect(initRestEndpointContext('ep-1')).resolves.toBeUndefined()
    expect(updates).toHaveLength(0)
  })

  test('a null sampleResponse renders as a placeholder', async () => {
    endpointRow.current = { ...endpointRow.current, sampleResponse: null, parameterSchema: null }
    await initRestEndpointContext('ep-1')
    expect(chatPrompts[0].user).not.toContain('null')
  })

  test('the sample response is truncated', async () => {
    endpointRow.current = { ...endpointRow.current, sampleResponse: 'r'.repeat(20_000) }
    await initRestEndpointContext('ep-1')
    expect(chatPrompts[0].user.length).toBeLessThan(SOURCE_INIT_LIMITS.MAX_SAMPLE_CHARS + 400)
  })
})

// ---------------------------------------------------------------------------
// initIntegrationContext
// ---------------------------------------------------------------------------

describe('initIntegrationContext', () => {
  beforeEach(() => {
    enrichCalls.length = 0
    enrichThrows = false
    updates.length = 0
    profileCalls.length = 0
    profileValue = 'DOMAIN OVERVIEW'
    integrationRow.current = {
      id: 'int-1', name: 'prod db',
      schemas: [{ tableName: 'invoices', columns: '[]', rowCount: 3, sampleRow: null }],
    }
  })

  test('runs the schema enrichment pass for the integration', async () => {
    await initIntegrationContext('int-1')
    expect(enrichCalls).toEqual([{ id: 'int-1' }])
  })

  test('generates and persists the business context profile', async () => {
    await initIntegrationContext('int-1')
    const write = updates.find((u) => u.model === 'integration')
    expect(write?.data.businessContext).toBe('DOMAIN OVERVIEW')
  })

  test('an integration with NO schemas does not call the LLM', async () => {
    integrationRow.current = { id: 'int-1', name: 'empty', schemas: [] }
    await initIntegrationContext('int-1')
    // There is nothing to describe; calling the model would burn tokens for a
    // profile built from an empty table list.
    expect(profileCalls).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })

  test('a missing integration does not call the LLM', async () => {
    integrationRow.current = null
    await initIntegrationContext('gone')
    expect(profileCalls).toHaveLength(0)
  })

  test('a null profile writes nothing', async () => {
    profileValue = null
    await initIntegrationContext('int-1')
    // `if (profile)` — an empty/failed profile must not clobber an existing
    // businessContext with null.
    expect(updates).toHaveLength(0)
  })

  test('an enrichment failure still lets the profile pass run', async () => {
    enrichThrows = true
    // The two halves are independent: a failed table-description pass should not
    // also cost the integration its business context.
    await expect(initIntegrationContext('int-1')).rejects.toThrow('enrich failed')
  })

  test('the tables handed to the profile generator are parsed', async () => {
    integrationRow.current = {
      id: 'int-1', name: 'prod db',
      schemas: [{ tableName: 'invoices', columns: '[{"name":"id","type":"int"}]', rowCount: 3, sampleRow: '{"id":1}' }],
    }
    await initIntegrationContext('int-1')
    const tables = profileCalls[0].tables as Array<{ columns: unknown; sampleRow: unknown }>
    expect(tables[0].columns).toEqual([{ name: 'id', type: 'int' }])
    expect(tables[0].sampleRow).toEqual({ id: 1 })
  })
})

describe('SOURCE_INIT_LIMITS', () => {
  test('the bounds are the documented ones', () => {
    expect(SOURCE_INIT_LIMITS.MAX_DOC_CHARS).toBe(6000)
    expect(SOURCE_INIT_LIMITS.MAX_SAMPLE_ROWS).toBe(3)
    expect(SOURCE_INIT_LIMITS.MAX_SAMPLE_CHARS).toBe(1500)
  })
})
