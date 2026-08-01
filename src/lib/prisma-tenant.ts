/**
 * Prisma tenant extension — auto-injects organizationId into all queries.
 * ----------------------------------------------------------------------------
 * Uses AsyncLocalStorage to track the current org context. When a request
 * comes in, getActiveUser() calls enterWithOrg(orgId). Every subsequent Prisma
 * query on org-scoped models automatically gets organizationId injected into
 * the where clause (reads) and data object (creates).
 *
 * Escape hatch: bypassOrg(fn) runs a callback without org scoping — used by
 * SSO login, signup, setup wizard, and seed scripts where no org context
 * exists yet or explicit org control is needed.
 *
 * ponytail: findUnique is NOT scoped (can't add non-unique fields to unique
 * where). IDs are cuid() random — cross-tenant access by ID is infeasible.
 * Ceiling: if a leaked ID from org A is used in org B's context, findUnique
 * would return it. Upgrade: convert findUnique to findFirst in the extension
 * (requires Prisma extension API support for operation substitution).
 */
import { Prisma } from '@prisma/client'
import { AsyncLocalStorage } from 'async_hooks'

const orgStorage = new AsyncLocalStorage<string>()

export function getOrgContext(): string | undefined {
  return orgStorage.getStore()
}

export function enterWithOrg(orgId: string): void {
  orgStorage.enterWith(orgId)
}

export async function bypassOrg<T>(fn: () => Promise<T>): Promise<T> {
  return orgStorage.run(undefined as unknown as string, fn)
}

// ponytail: org-scoped models — every model that has organizationId.
// Organization and Invitation are NOT scoped (they ARE the org layer).
const ORG_SCOPED_MODELS = new Set([
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
])

// Operations that accept a where clause for filtering (non-unique)
const FILTER_OPS = new Set([
  'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
])

// Operations that mutate via where clause
const MUTATE_WHERE_OPS = new Set([
  'update', 'updateMany', 'delete', 'deleteMany',
])

// Operations that create data
const CREATE_OPS = new Set([
  'create', 'createMany', 'createManyAndReturn',
])

function injectOrgWhere(args: any, orgId: string): any {
  if (!args.where) {
    args.where = { organizationId: orgId }
  } else if (args.where.organizationId === undefined) {
    args.where = { ...args.where, organizationId: orgId }
  }
  return args
}

function injectOrgCreate(args: any, orgId: string): any {
  if (!args.data) return args
  if (Array.isArray(args.data)) {
    args.data = args.data.map((d: any) =>
      d.organizationId === undefined ? { ...d, organizationId: orgId } : d,
    )
  } else {
    if (args.data.organizationId === undefined) {
      args.data = { ...args.data, organizationId: orgId }
    }
  }
  return args
}

export function createTenantExtension() {
  return Prisma.defineExtension({
    name: 'tenant',
    query: {
      async $allOperations({ args, query, model, operation }) {
        const orgId = orgStorage.getStore()
        if (!orgId || !model || !ORG_SCOPED_MODELS.has(model)) {
          return query(args)
        }

        if (FILTER_OPS.has(operation)) {
          args = injectOrgWhere(args, orgId)
        } else if (CREATE_OPS.has(operation)) {
          args = injectOrgCreate(args, orgId)
        } else if (MUTATE_WHERE_OPS.has(operation)) {
          // Inject orgId into where to prevent cross-tenant mutations
          args = injectOrgWhere(args, orgId)
        } else if (operation === 'upsert') {
          // ponytail: upsert where must be unique — don't inject into where.
          // Only inject into create data. If the record exists in another org,
          // the update path runs (potential cross-tenant issue) but in practice
          // upserts are only used in seed scripts with bypassOrg().
          if (args.create?.organizationId === undefined) {
            args.create = { ...args.create, organizationId: orgId }
          }
        }
        // findUnique/findUniqueOrThrow: skipped (see file-level comment)

        return query(args)
      },
    },
  })
}
