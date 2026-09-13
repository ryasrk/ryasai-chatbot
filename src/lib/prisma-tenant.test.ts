import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ===========================================================================
// prisma-tenant.ts — THE TENANT ISOLATION EXTENSION
// ===========================================================================
//
// This is the module that keeps one organization from reading another's rows, and
// it had NO direct test. Forty-three test files import it, but all of them MOCK it,
// so the real injection code was never executed (63.41% executable, with every
// branch of injectOrgWhere/injectOrgCreate unreached). The file's own header
// records what that costs in production when it is wrong.

// Capture the extension's $allOperations handler. `Prisma.defineExtension` merely
// wraps the object it is given, so returning the input unchanged exposes the real
// handler without importing a live Prisma client.
type AllOps = (ctx: {
  args: Record<string, unknown>
  query: (a: Record<string, unknown>) => Promise<unknown>
  model?: string
  operation: string
}) => Promise<unknown>
let captured: AllOps | null = null

mock.module('@prisma/client', () => ({
  Prisma: {
    defineExtension: (ext: { query: { $allOperations: AllOps } }) => {
      captured = ext.query.$allOperations
      return ext
    },
  },
}))

const { getOrgContext, enterWithOrg, bypassOrg, createTenantExtension } = await import('./prisma-tenant')

// Force the handler to be captured at load.
createTenantExtension()

/** Runs the real handler and returns the args it forwarded to `query`. */
async function run(op: {
  model?: string
  operation: string
  args?: Record<string, unknown>
  orgId?: string
  bypass?: boolean
}): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> = {}
  const invoke = async () => {
    await captured!({
      args: op.args ?? {},
      query: async (a) => { seen = a; return 'q' },
      model: op.model,
      operation: op.operation,
    })
    return seen
  }
  if (op.bypass) return bypassOrg(invoke)
  if (op.orgId) enterWithOrg(op.orgId)
  else enterWithOrg('')
  return invoke()
}

beforeEach(() => {
  expect(captured).not.toBeNull()
})

describe('org context storage', () => {
  test('enterWithOrg then getOrgContext round-trips', async () => {
    await bypassOrg(async () => {
      enterWithOrg('org-x')
      expect(getOrgContext()).toBe('org-x')
    })
  })

  test('bypassOrg runs the callback with NO org context', async () => {
    enterWithOrg('org-x')
    const seen = await bypassOrg(async () => getOrgContext())
    // Inside the callback the store is cleared...
    expect(seen).toBeUndefined()
  })
})

describe('createTenantExtension — the extension is declared correctly', () => {
  test('it is a named "tenant" extension exposing $allOperations', async () => {
    const ext = createTenantExtension() as { name: string }
    expect(ext.name).toBe('tenant')
    expect(captured).not.toBeNull()
  })
})

describe('READS — org scoping is injected', () => {
  test('findMany with no where gets an organizationId filter', async () => {
    const args = await run({ model: 'User', operation: 'findMany', orgId: 'org-a' })
    expect(args.where).toEqual({ organizationId: 'org-a' })
  })

  test('findFirst, count, aggregate and groupBy are all scoped', async () => {
    // Every FILTER_OPS entry, because a single omission is a cross-tenant leak on
    // whichever route happens to use it.
    for (const operation of ['findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy']) {
      const args = await run({ model: 'Document', operation, orgId: 'org-a' })
      expect(args.where).toEqual({ organizationId: 'org-a' })
    }
  })

  test('an EXISTING filter is preserved alongside the injected org', async () => {
    // Overwriting the caller's where would silently drop their filters -- a
    // correctness bug that looks like missing rows.
    const args = await run({
      model: 'AuditLog',
      operation: 'findMany',
      orgId: 'org-a',
      args: { where: { severity: 'critical' } },
    })
    expect(args.where).toEqual({ severity: 'critical', organizationId: 'org-a' })
  })

  test('an EXPLICIT organizationId is NOT overridden', async () => {
    // Some paths legitimately scope explicitly (admin cross-org reads). Clobbering
    // it would break them silently.
    const args = await run({
      model: 'User',
      operation: 'findMany',
      orgId: 'org-a',
      args: { where: { organizationId: 'org-b' } },
    })
    expect(args.where).toEqual({ organizationId: 'org-b' })
  })

  test('findUnique is deliberately NOT scoped', async () => {
    // The documented ceiling: Prisma's unique where rejects extra fields. Pinned so
    // a future change is a deliberate decision, not an accident.
    const args = await run({
      model: 'User',
      operation: 'findUnique',
      orgId: 'org-a',
      args: { where: { id: 'abc' } },
    })
    expect(args.where).toEqual({ id: 'abc' })
  })
})

describe('MUTATIONS — org is injected into where', () => {
  test('update/delete/updateMany/deleteMany are all scoped', async () => {
    for (const operation of ['update', 'updateMany', 'delete', 'deleteMany']) {
      const args = await run({ model: 'ChatSession', operation, orgId: 'org-a', args: { where: { id: 'x' } } })
      expect(args.where).toEqual({ id: 'x', organizationId: 'org-a' })
    }
  })

  test('a delete with NO where is STILL scoped (never deleteMany across tenants)', async () => {
    // deleteMany with no where is a full-table delete. If the extension left it
    // unscoped it would wipe every organization's rows.
    const args = await run({ model: 'ToolRun', operation: 'deleteMany', orgId: 'org-a' })
    expect(args.where).toEqual({ organizationId: 'org-a' })
  })
})

describe('CREATES — org is injected into data', () => {
  test('create stamps organizationId', async () => {
    const args = await run({ model: 'QueryHistory', operation: 'create', orgId: 'org-a', args: { data: { sql: 'x' } } })
    expect(args.data).toEqual({ sql: 'x', organizationId: 'org-a' })
  })

  test('createMany stamps EVERY row', async () => {
    const args = await run({
      model: 'KgRelation',
      operation: 'createMany',
      orgId: 'org-a',
      args: { data: [{ source: 'a' }, { source: 'b' }] },
    })
    expect(args.data).toEqual([
      { source: 'a', organizationId: 'org-a' },
      { source: 'b', organizationId: 'org-a' },
    ])
  })

  test('createManyAndReturn is scoped too', async () => {
    const args = await run({ model: 'DocumentChunk', operation: 'createManyAndReturn', orgId: 'org-a', args: { data: [{ text: 't' }] } })
    expect(args.data).toEqual([{ text: 't', organizationId: 'org-a' }])
  })

  test('an explicit organizationId in data is NOT overwritten', async () => {
    const args = await run({
      model: 'User',
      operation: 'create',
      orgId: 'org-a',
      args: { data: { organizationId: 'org-b' } },
    })
    expect(args.data).toEqual({ organizationId: 'org-b' })
  })

  test('createMany leaves rows that already carry an organizationId alone', async () => {
    // A mixed batch is realistic during an org migration; the ones already stamped
    // must not be reassigned.
    const args = await run({
      model: 'User',
      operation: 'createMany',
      orgId: 'org-a',
      args: { data: [{ organizationId: 'org-b' }, { name: 'n' }] },
    })
    expect(args.data).toEqual([{ organizationId: 'org-b' }, { name: 'n', organizationId: 'org-a' }])
  })

  test('a create with NO data is returned untouched', async () => {
    // `if (!args.data) return args` -- nothing to stamp, and it must not crash.
    const args = await run({ model: 'User', operation: 'create', orgId: 'org-a' })
    expect(args.data).toBeUndefined()
  })
})

describe('upsert — create data only, never the unique where', () => {
  test('organizationId goes into create, not where', async () => {
    // Injecting into a unique where would make Prisma reject the query outright.
    const args = await run({
      model: 'AppConfig',
      operation: 'upsert',
      orgId: 'org-a',
      args: { where: { key: 'k' }, create: { value: 'v' }, update: { value: 'w' } },
    })
    expect(args.where).toEqual({ key: 'k' })
    expect(args.create).toEqual({ value: 'v', organizationId: 'org-a' })
  })

  test('an explicit organizationId in create is preserved', async () => {
    const args = await run({
      model: 'AppConfig',
      operation: 'upsert',
      orgId: 'org-a',
      args: { where: { key: 'k' }, create: { organizationId: 'org-b' } },
    })
    expect(args.create).toEqual({ organizationId: 'org-b' })
  })
})

describe('the extension must do NOTHING without an org context', () => {
  test('with NO org id, no filter is injected', async () => {
    // This is the fail-open case the previous module went to some trouble to avoid
    // elsewhere; here it is CORRECT, because bypassOrg is the explicit opt-out and
    // addWhere would break login/signup lookups.
    const args = await bypassOrg(async () => run({ model: 'User', operation: 'findMany', bypass: true }))
    expect(args.where).toBeUndefined()
  })

  test('a NON-org-scoped model is passed through untouched', async () => {
    // Organization and Invitation ARE the org layer; scoping them would make signup
    // and invitation acceptance impossible.
    const args = await run({ model: 'Organization', operation: 'findMany', orgId: 'org-a' })
    expect(args.where).toBeUndefined()
  })

  test('a missing model name is passed through untouched', async () => {
    const args = await run({ operation: 'findMany', orgId: 'org-a' })
    expect(args.where).toBeUndefined()
  })

  test('an operation OUTSIDE every set is passed through untouched', async () => {
    // e.g. findRaw/runCommand -- untouched rather than mis-injected.
    const args = await run({ model: 'User', operation: 'someUnknownOp', orgId: 'org-a', args: { where: { a: 1 } } })
    expect(args.where).toEqual({ a: 1 })
  })
})

describe('the PASCALCASE normalisation that silently broke scoping', () => {
  test('a schema-cased model name IS matched', async () => {
    // The header calls this out: Prisma passes "User", the set is keyed "user".
    // Without the lowercasing the injection NEVER fires and every read leaks. Each
    // scoped model is checked in BOTH casings.
    for (const model of ['User', 'Document', 'ChatSession', 'McpServer', 'ScheduledRun']) {
      const args = await run({ model, operation: 'findMany', orgId: 'org-a' })
      expect(args.where).toEqual({ organizationId: 'org-a' })
    }
  })

  test('every model listed in ORG_SCOPED_MODELS is actually matched', async () => {
    // The list is the security boundary: a model that has organizationId in the
    // schema but is MISSING from the set is queried unscoped. This asserts the
    // normalisation works for all of them rather than a hand-picked few.
    const models = [
      'user', 'integration', 'integrationSchema', 'llmConfig', 'document', 'documentChunk',
      'kgRelation', 'vectorStoreConfig', 'chatSession', 'chatMessage', 'appConfig',
      'restApiConnector', 'restApiEndpoint', 'restApiRequestLog', 'toolRun', 'apiKey',
      'apiRequestLog', 'auditLog', 'queryHistory', 'plugin', 'mcpServer', 'scheduledRun',
      'scheduledRunLog', 'notificationConfig', 'agentRun', 'llmUsageLog', 'documentVersion',
      'savedPrompt',
    ]
    for (const m of models) {
      const pascal = m.charAt(0).toUpperCase() + m.slice(1)
      const args = await run({ model: pascal, operation: 'findMany', orgId: 'org-a' })
      expect(args.where).toEqual({ organizationId: 'org-a' })
    }
  })
})
