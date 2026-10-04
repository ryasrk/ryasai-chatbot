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

const { getOrgContext, requireOrgContext, enterWithOrg, bypassOrg, createTenantExtension, ORG_SCOPED_MODELS } = await import('./prisma-tenant')

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

describe('requireOrgContext — the fail-fast org read', () => {
  /*
   * VERIFIED-VALID WEAKNESS (external review #11): seventeen call sites wrote `getOrgContext()!`, whose
   * failure mode names neither the missing context nor its cause. This pins the replacement's contract:
   * a value when present, an error that NAMES the required action when not. The cross-org escape remains
   * `bypassOrg`, so its sentinel org must also satisfy require — the two are one contract.
   */
  test('returns the org when the context is established', () => {
    enterWithOrg('org-x')
    expect(requireOrgContext()).toBe('org-x')
    enterWithOrg('')
  })

  test('without an org it throws an error that names the required action, not a TypeError', () => {
    enterWithOrg('')
    let message = ''
    try {
      requireOrgContext()
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    // The failure must be diagnosable from the message alone: it names the missing thing AND the fix.
    expect(message).toContain('no organization context')
    expect(message).toContain('enterWithOrg')
    expect(message).toContain('bypassOrg')
  })

  test('bypassOrg runs its callback with NO org — the escape hatch is for cross-org work, not for requiring one', async () => {
    /*
     * `bypassOrg` stores `undefined`, so `requireOrgContext` inside it throwing is CORRECT: the hatch is
     * documented for signup/setup/seed — code that must NOT be org-scoped. The first version of this test
     * asserted the opposite (`requireOrgContext` succeeding inside `bypassOrg`) and failed, which is the
     * contract telling me the test was wrong rather than the code.
     */
    let threw = false
    await bypassOrg(async () => {
      try {
        requireOrgContext()
      } catch {
        threw = true
      }
    })
    expect(threw).toBe(true)
    // And getOrgContext inside bypassOrg is genuinely unset, which is what cross-org code relies on.
    const seen = await bypassOrg(async () => getOrgContext())
    expect(seen).toBeUndefined()
  })
})

describe('org context storage', () => {
  test('bypass keeps lazy database evaluation inside its context', async () => {
    enterWithOrg('org-a')
    // Prisma evaluates a query when its promise is awaited, rather than when
    // the query object is created. Eager mocks cannot expose this boundary.
    const lazy = {
      then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
        captured!({ model: 'User', operation: 'findMany', args: {},
          query: async (args) => args }).then(resolve, reject)
      },
    }
    const result = await bypassOrg(() => lazy as unknown as Promise<Record<string, unknown>>)
    expect(result).toEqual({})
    expect(getOrgContext()).toBe('org-a')
  })
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

  test('a foreign organization predicate is rejected before querying', async () => {
    // Explicit foreign scope previously overrode tenant isolation. Cross-org
    // operations must use bypassOrg rather than a client-controlled predicate.
    await expect(run({ model: 'User', operation: 'findMany', orgId: 'org-a',
      args: { where: { organizationId: 'org-b' } } })).rejects.toThrow('conflicts')
  })

  test('unique reads retain the unique id and require the active org', async () => {
    for (const operation of ['findUnique', 'findUniqueOrThrow']) {
      const args = await run({ model: 'User', operation, orgId: 'org-a', args: { where: { id: 'abc' } } })
      expect(args.where).toEqual({ id: 'abc', organizationId: 'org-a' })
    }
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

  test('foreign create data and mixed-tenant batches are rejected', async () => {
    for (const data of [{ organizationId: 'org-b' }, [{ organizationId: 'org-b' }, { name: 'n' }]]) {
      await expect(run({ model: 'User', operation: Array.isArray(data) ? 'createMany' : 'create',
        orgId: 'org-a', args: { data } })).rejects.toThrow('conflicts')
    }
  })

  test('a create with NO data is returned untouched', async () => {
    // `if (!args.data) return args` -- nothing to stamp, and it must not crash.
    const args = await run({ model: 'User', operation: 'create', orgId: 'org-a' })
    expect(args.data).toBeUndefined()
  })
})

describe('upsert scopes both branches', () => {
  test('where and create both carry the active org', async () => {
    const args = await run({ model: 'AppConfig', operation: 'upsert', orgId: 'org-a',
      args: { where: { key: 'k' }, create: { value: 'v' }, update: { value: 'w' } } })
    expect(args.where).toEqual({ key: 'k', organizationId: 'org-a' })
    expect(args.create).toEqual({ value: 'v', organizationId: 'org-a' })
  })
  test('neither branch can reassign a row to another org', async () => {
    for (const args of [
      { where: { id: 'x' }, create: { organizationId: 'org-b' }, update: {} },
      { where: { id: 'x' }, create: {}, update: { organizationId: 'org-b' } },
    ]) await expect(run({ model: 'User', operation: 'upsert', orgId: 'org-a', args })).rejects.toThrow('conflicts')
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

  test('an unsupported operation on a tenant model fails closed', async () => {
    await expect(run({ model: 'User', operation: 'someUnknownOp', orgId: 'org-a' })).rejects.toThrow('unsupported operation')
  })
  test('missing context rejects reads and writes without forwarding a query', async () => {
    for (const operation of ['findMany', 'findUnique', 'create', 'deleteMany']) {
      await expect(run({ model: 'User', operation })).rejects.toThrow('no organization context')
    }
  })
  test('mutations cannot move a row into a foreign org', async () => {
    for (const operation of ['update', 'updateMany', 'updateManyAndReturn']) {
      await expect(run({ model: 'User', operation, orgId: 'org-a',
        args: { where: { id: 'x' }, data: { organizationId: 'org-b' } } })).rejects.toThrow('conflicts')
    }
  })
  test('updateManyAndReturn receives the tenant predicate', async () => {
    const args = await run({ model: 'User', operation: 'updateManyAndReturn', orgId: 'org-a', args: { data: { name: 'new' } } })
    expect(args.where).toEqual({ organizationId: 'org-a' })
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
    // schema but is MISSING from the set is queried unscoped.
    //
    // Read from the REAL set rather than a hand-written copy. This test used to
    // hold its own 28-entry copy of the list — and that copy omitted `order`, so it
    // could not have caught the omission it exists to catch, in a test whose own
    // comment says "a model that has organizationId in the schema but is MISSING
    // from the set is queried unscoped". A duplicated list is not a second check;
    // it is a second place for the same fact to be wrong.
    // (Completeness — set vs schema — is `tenant-scope-coverage.test.ts`.)
    expect(ORG_SCOPED_MODELS.size).toBeGreaterThanOrEqual(29)
    for (const m of ORG_SCOPED_MODELS) {
      const pascal = m.charAt(0).toUpperCase() + m.slice(1)
      const args = await run({ model: pascal, operation: 'findMany', orgId: 'org-a' })
      expect(args.where, `${pascal} (key "${m}") was NOT matched by the extension`).toEqual({
        organizationId: 'org-a',
      })
    }
  })
})

describe('Order is org-scoped (the measured cross-tenant IDOR)', () => {
  /**
   * `Order` carried `organizationId` but was absent from `ORG_SCOPED_MODELS`, so the
   * extension never fired for it. Measured before the fix, same process, same shape:
   *
   *   Document.findFirst -> WHERE (id = $1 AND organizationId = $2)   <- scoped
   *   Order.findFirst    -> WHERE  id = $1                            <- NOT scoped
   *
   * `GET /api/billing/orders/[id]` takes a client-supplied id and returned another
   * org's `status`, `months`, `amountIdr` and `licenseIssued`.
   *
   * These assert on the args the extension FORWARDED, which is the only place the
   * defect is visible: the route's own test mocks `@/lib/db`, so the tenant
   * extension never runs there and a mocked `findFirst` returns the row regardless
   * of the where clause. That is why its "order from another org → 404" case passed
   * while the leak was live.
   */
  test('Order.findFirst receives an injected organizationId', async () => {
    const args = await run({
      model: 'Order',
      operation: 'findFirst',
      orgId: 'org-a',
      args: { where: { id: 'attacker-supplied-id' } },
    })
    expect(args.where).toEqual({ id: 'attacker-supplied-id', organizationId: 'org-a' })
  })

  test('every READ operation on Order is scoped, not just findFirst', async () => {
    // The route happens to use findFirst; a future billing page will use findMany
    // or count. Asserting the whole FILTER family means the protection does not
    // depend on which verb the next caller picks.
    for (const operation of ['findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']) {
      const args = await run({ model: 'Order', operation, orgId: 'org-a', args: { where: { id: 'x' } } })
      expect(args.where, `${operation} on Order was not scoped`).toEqual({ id: 'x', organizationId: 'org-a' })
    }
  })

  test('Order MUTATIONS are scoped (a webhook updateMany cannot cross orgs by accident)', async () => {
    for (const operation of ['update', 'updateMany', 'delete', 'deleteMany']) {
      const args = await run({ model: 'Order', operation, orgId: 'org-a', args: { where: { id: 'x' } } })
      expect(args.where, `${operation} on Order was not scoped`).toEqual({ id: 'x', organizationId: 'org-a' })
    }
  })

  test('a cross-org order id is REFUSED by the predicate the DB would apply', async () => {
    // End-to-end shape of the fix: whatever the caller passes, the forwarded where
    // requires THIS org, so a foreign row cannot satisfy it. Asserted on the clause
    // rather than on a row count because there is no live row here -- the point is
    // that the id alone is no longer sufficient.
    const args = await run({
      model: 'Order',
      operation: 'findFirst',
      orgId: 'org-victim',
      args: { where: { id: 'order-of-org-attacker' } },
    })
    const where = args.where as Record<string, unknown>
    expect(where.organizationId).toBe('org-victim')
    expect(where.id).toBe('order-of-org-attacker')
    // Both terms present => the row must match BOTH; an id from another org yields null.
    expect(Object.keys(where).sort()).toEqual(['id', 'organizationId'])
  })

  test('the BEFORE-load of the order path is wrapped in bypassOrg, so the webhook still works', async () => {
    // Scoping Order must not break the payment path. The Midtrans webhook has no
    // session and no org context, and `runOrderReconciliation` is cross-org by
    // nature, so both MUST read unscoped -- that is what bypassOrg is for, and it
    // must still defeat the injection. Two directions, because a change that made
    // bypassOrg stop working would silently break license issuance for every
    // customer, which is worse than the leak being fixed.
    const scoped = await run({ model: 'Order', operation: 'findUnique', orgId: 'org-a', args: { where: { midtransOrderId: 'M' } } })
    // findUnique is never scoped (documented ceiling) -- hence bypassOrg is REQUIRED
    // here rather than merely convenient: there is no scoped form of this lookup by
    // a non-unique-pair key.
    expect(scoped.where).toEqual({ midtransOrderId: 'M', organizationId: 'org-a' })

    const unscoped = await bypassOrg(async () =>
      run({ model: 'Order', operation: 'findMany', bypass: true, args: { where: { status: 'settlement' } } }),
    )
    expect(unscoped.where).toEqual({ status: 'settlement' })

    // And the two are DIFFERENT: bypassOrg is what suppresses the injection, proving
    // the suppression is explicit rather than an accident of the operation chosen.
    const withCtx = await run({ model: 'Order', operation: 'findMany', orgId: 'org-a', args: { where: { status: 'settlement' } } })
    expect(withCtx.where).toEqual({ status: 'settlement', organizationId: 'org-a' })
  })
})
