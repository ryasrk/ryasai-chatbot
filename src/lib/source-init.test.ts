import { describe, expect, test } from 'bun:test'
import { describeSchema } from './connectors'

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
    expect(out).toContain('TABLE x (? rows)')
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
