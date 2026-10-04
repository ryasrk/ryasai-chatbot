/**
 * Prisma tenant extension — auto-injects organizationId into all queries.
 * ----------------------------------------------------------------------------
 * Uses AsyncLocalStorage to track the current org context. When a request
 * comes in, its handler must call enterWithOrg(orgId). Every subsequent Prisma
 * query on org-scoped models automatically gets organizationId injected into
 * the where clause (reads) and data object (creates).
 *
 * Escape hatch: bypassOrg(fn) runs a callback without org scoping — used by
 * SSO login, signup, setup wizard, and seed scripts where no org context
 * exists yet or explicit org control is needed.
 *
 * ponytail: findUnique lookups were previously unscoped. Prisma 6 now accepts an
 * additional organizationId predicate; the extension applies it as defence in depth. The original rationale here was "IDs are cuid() random — cross-tenant
 * access by ID is infeasible", which is security-through-obscurity and was
 * measurably FALSE: `api/mcp/servers/route.ts` returns `id: true` to the browser,
 * so a legitimate org-A user holds their own server IDs in plain sight and those
 * IDs resolve in org B's context. Two routes were exploitable this way
 * (`mcp/servers/[id]` GET/PATCH/DELETE, and `chat/sessions/[id]/send` reading
 * `body.promptId`), both of which DO call getActiveUser()+enterWithOrg() — so
 * their ritual was correct and the org context was simply ignored by the query.
 *
 * Fix direction: use `findFirst` (or `findFirstOrThrow`) with the ID in the
 * where clause when you are loading a row by a client-supplied identifier. The
 * extension then injects organizationId automatically and a cross-tenant ID
 * yields null instead of another tenant's row. `findUnique` remains legitimate
 * for (a) pre-auth lookups where no org exists yet (login, signup, invitation
 * tokens) and (b) re-reading a row this same handler just created.
 *
 * Raw SQL and nested relation operations require explicit ownership checks.
 * Client-supplied IDs still use findFirst; the invariant allowlist enforces
 * that convention independently of runtime scoping. Missing context fails closed.
 *
 * THERE ARE TWO INDEPENDENT WAYS ISOLATION IS LOST HERE, and the first one hid
 * behind the second for months:
 *
 *   1. MODEL MEMBERSHIP. A model can be absent from `ORG_SCOPED_MODELS` even
 *      though it HAS `organizationId`. Then EVERY operation on it is unscoped,
 *      not just findUnique — the handler's org ritual is irrelevant because the
 *      extension never fires. This is how `Order` leaked (see the entry below):
 *      the guards all checked the OPERATION (`findUnique` vs `findFirst`) and
 *      nothing checked the MODEL. `tenant-scope-coverage.test.ts` now does.
 *   2. OPERATION COVERAGE. On a model that IS listed, every supported operation must receive the tenant predicate.
 *
 * So "the query used findFirst and the route called enterWithOrg" is NOT
 * sufficient evidence of isolation. Check the model is in the set.
 */
import { Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'async_hooks'

// Next instrumentation and route bundles must share the same context stores.
// Module-local stores diverge across bundles and development reloads.
const tenantGlobal = globalThis as unknown as {
  ryasaiOrgStorage?: AsyncLocalStorage<string>
  ryasaiBypassStorage?: AsyncLocalStorage<boolean>
}
const orgStorage = tenantGlobal.ryasaiOrgStorage ??= new AsyncLocalStorage<string>()
const bypassStorage = tenantGlobal.ryasaiBypassStorage ??= new AsyncLocalStorage<boolean>()

export function getOrgContext(): string | undefined {
  return orgStorage.getStore()
}

/**
 * `getOrgContext()`, but with the two things its `!`-asserting callers each had to improvise.
 *
 * WHY THIS EXISTS (verified-valid weakness, external review #11). Seventeen call sites wrote
 * `getOrgContext()!`, which does the OPPOSITE of what they intended: when the context is genuinely missing the
 * non-null assertion throws `TypeError: Cannot read properties of undefined` (or Prisma's own error on
 * `organizationId: undefined`) — a message that names neither the org context nor the likely cause. The
 * instruction every route follows ("call enterWithOrg itself") is what normally guarantees the store; a
 * missing value therefore means the guard was skipped, and the useful error is the one that SAYS so.
 *
 * The name is the contract: `require` — the caller cannot proceed without it. Cross-org work goes through
 * `bypassOrg`, which is the documented escape hatch for the no-org cases (signup, setup, seed).
 */
export function requireOrgContext(): string {
  const orgId = orgStorage.getStore()
  if (!orgId) {
    throw new Error(
      'requireOrgContext: no organization context — the route or worker must call enterWithOrg(...) ' +
        'before any org-scoped write (cross-org work belongs in bypassOrg(fn))',
    )
  }
  return orgId
}

export function enterWithOrg(orgId: string): void {
  orgStorage.enterWith(orgId)
}

export async function bypassOrg<T>(fn: () => Promise<T>): Promise<T> {
  // PrismaPromise is lazy: await it inside the context, before its then() executes.
  return bypassStorage.run(true, () => orgStorage.run(undefined as unknown as string, async () => await fn()))
}

// ponytail: org-scoped models — every model that has organizationId, MINUS the
// explicit exceptions listed in ORG_SCOPE_EXCEPTIONS below.
//
// THE TWO EXCLUSIONS ARE DIFFERENT FACTS AND MUST NOT BE CONFLATED:
//   - `Organization` is not scoped because it IS the org root: it has no
//     `organizationId` column to inject.
//   - `Invitation` HAS `organizationId` and is deliberately unscoped, because
//     accepting an invitation is pre-auth — the token IS the credential and
//     there is no org context to inject yet. See ORG_SCOPE_EXCEPTIONS.
//
// This list is no longer maintained by hand. `tenant-scope-coverage.test.ts`
// parses prisma/schema.prisma, derives the set of models carrying
// `organizationId`, and fails if any of them is missing here. Add a model to the
// schema without adding it here and that test fails NAMING the model.
//
// Exported as a `ReadonlySet` so the guard compares against THE set the extension
// actually consults, rather than a second hand-written copy that could drift —
// a duplicate list is the artifact whose failure is being fixed here. Read-only
// because nothing outside this module should be able to widen or narrow scope.
export const ORG_SCOPED_MODELS: ReadonlySet<string> = new Set([
  'user',
  'integration',
  'integrationSchema',
  'llmConfig',
  'document',
  'documentChunk',
  'kgRelation',
  'vectorStoreConfig',
  'chatSession',
  'chatMessage',
  'appConfig',
  'restApiConnector',
  'restApiEndpoint',
  'restApiRequestLog',
  'toolRun',
  'apiKey',
  'apiRequestLog',
  'auditLog',
  'queryHistory',
  'plugin',
  'mcpServer',
  'scheduledRun',
  'scheduledRunLog',
  'notificationConfig',
  'agentRun',
  'llmUsageLog',
  'documentVersion',
  'savedPrompt',
  // WHY 'order' IS HERE AND WAS NOT BEFORE: `Order` has carried `organizationId`
  // since the model was added (2026-09), but it was omitted from this set when it
  // was created — and nothing caught the omission, because the only guard was a
  // hand-maintained list checked per-model, never against the schema.
  //
  // The omission was a LIVE cross-tenant IDOR, not a theoretical one. Measured by
  // driving the real handler and reading the SQL Prisma emitted:
  //     Document.findFirst -> WHERE (id = $1 AND organizationId = $2)   <- scoped
  //     Order.findFirst    -> WHERE  id = $1                            <- NOT scoped
  // `GET /api/billing/orders/[id]` (client-supplied order id) returned another
  // org's `status`, `months`, `amountIdr` and `licenseIssued` for any order id in
  // the install. Its docstring claimed the extension scoped the read, which is
  // exactly why nobody re-checked it — the false claim is fixed in that file too.
  'order',
])

/**
 * Models that carry `organizationId` but are DELIBERATELY not org-scoped.
 *
 * Exported so `tenant-scope-coverage.test.ts` can compare the schema against
 * `ORG_SCOPED_MODELS ∪ ORG_SCOPE_EXCEPTIONS` instead of against a second
 * hand-written copy of this list — a duplicated list would drift exactly like the
 * one that let `Order` through.
 *
 * Every entry MUST state its reason. An entry here is a place isolation does not
 * happen automatically, so adding one is a security decision, not a formality.
 */
export const ORG_SCOPE_EXCEPTIONS: Readonly<Record<string, string>> = {
  invitation: 'pre-auth: accepting an invite has no org context yet — the token IS the credential, and the invite route supplies organizationId explicitly in its compound unique key',
}

// Operations that accept a where clause for filtering (non-unique)
const FILTER_OPS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
  'findUnique', 'findUniqueOrThrow',
])

// Operations that mutate via where clause
const MUTATE_WHERE_OPS = new Set([
  'update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany',
])

// Operations that create data
const CREATE_OPS = new Set([
  'create', 'createMany', 'createManyAndReturn',
])

function injectOrgWhere(args: any, orgId: string): any {
  if (!args.where) {
    args.where = { organizationId: orgId }
  } else {
    if (args.where.organizationId !== undefined && args.where.organizationId !== orgId) {
      throw new Error('Tenant isolation: organizationId conflicts with the active organization; cross-org work requires bypassOrg(fn)')
    }
    args.where = { ...args.where, organizationId: orgId }
  }
  return args
}

function assertOrgId(value: unknown, orgId: string): void {
  if (value !== undefined && value !== orgId) {
    throw new Error('Tenant isolation: organizationId conflicts with the active organization; cross-org work requires bypassOrg(fn)')
  }
}

function injectOrgCreate(args: any, orgId: string): any {
  if (!args.data) return args
  const stamp = (data: any) => {
    assertOrgId(data.organizationId, orgId)
    return { ...data, organizationId: orgId }
  }
  args.data = Array.isArray(args.data) ? args.data.map(stamp) : stamp(args.data)
  return args
}

export function createTenantExtension() {
  return Prisma.defineExtension({
    name: 'tenant',
    query: {
      async $allOperations({ args, query, model, operation }) {
        const orgId = orgStorage.getStore()
        // ponytail: Prisma passes model names in schema case (PascalCase, e.g. "User").
        // ORG_SCOPED_MODELS is keyed by first-lowercase names ("user") — normalize
        // before matching, otherwise injection silently never fires (cross-org leak).
        const modelKey = model ? model.charAt(0).toLowerCase() + model.slice(1) : undefined
        if (!model || !modelKey || !ORG_SCOPED_MODELS.has(modelKey) || bypassStorage.getStore()) {
          return query(args)
        }

        if (!orgId) requireOrgContext()
        const activeOrg = orgId as string

        if (FILTER_OPS.has(operation)) {
          args = injectOrgWhere(args, activeOrg)
        } else if (CREATE_OPS.has(operation)) {
          args = injectOrgCreate(args, activeOrg)
        } else if (MUTATE_WHERE_OPS.has(operation)) {
          args = injectOrgWhere(args, activeOrg)
          if (args.data) assertOrgId(args.data.organizationId, activeOrg)
        } else if (operation === 'upsert') {
          // Prisma 6 accepts additional non-unique predicates in a unique where.
          // Both the existing-row branch and the create branch must belong to this org.
          args = injectOrgWhere(args, activeOrg)
          const createArgs = injectOrgCreate({ data: args.create }, activeOrg)
          args.create = createArgs.data
          if (args.update) assertOrgId(args.update.organizationId, activeOrg)
        } else {
          throw new Error(`Tenant isolation: unsupported operation ${operation} on ${model}`)
        }

        return query(args)
      },
    },
  })
}
