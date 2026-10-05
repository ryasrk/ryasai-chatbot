# Multi-Tenant Architecture — Quick Reference

ryasai is deployed on-prem per customer. One installation can contain multiple organizations,
with data isolated by `organizationId`. The signed machine-bound licence is the entitlement;
customers configure their own AI providers. See [Architecture](./ARCHITECTURE.md).

## Establish the tenant context

Each authenticated route must establish context in its own frame after authentication:

```typescript
const user = await getActiveUser()
enterWithOrg(user.organizationId)
const docs = await db.document.findMany()
```

`enterWithOrg(orgId)` returns `void`; it takes no callback. `getOrgContext()` returns the org ID
string or `undefined`. Use `requireOrgContext()` when a missing context must throw.
Context established inside `getActiveUser()` does not propagate back to the caller's frame.

## Database access

The Prisma extension injects tenant predicates into supported operations on scoped models.
Missing context and explicit foreign tenant IDs fail closed. Loading a row by a client-supplied
ID uses `findFirst` or `findFirstOrThrow`, including when runtime unique-read scoping is available.
Raw SQL and nested relation operations require explicit ownership checks.

```typescript
const orgId = requireOrgContext()
const chunks = await db.$queryRaw`
  SELECT id, content FROM "DocumentChunk"
  WHERE "organizationId" = ${orgId}
`
```

`ORG_SCOPED_MODELS` and `ORG_SCOPE_EXCEPTIONS` in
[prisma-tenant.ts](./src/lib/prisma-tenant.ts) are the membership authority.
`Invitation` is an explicit pre-auth exception; `Organization` is the tenant root and needs
explicit selection. `bypassOrg(fn)` is a deliberate escape hatch for pre-auth or cross-org work,
including signup, setup, SSO and seeding. It does not authenticate or authorize its caller.

## Background work and retrieval

Workers must establish the target org context before reading configuration or data and consult
`getLockdownReason` before executing licensed work. BYOK credentials and document retrieval use
that context. Raw retrieval SQL must include the org predicate.

SSO selects `SSO_ORGANIZATION_ID` when configured, otherwise the sole existing organization.
Provisioning fails when no organization exists or the target is ambiguous.

## Verification

Run test files in separate processes to avoid Bun mock leakage:

```bash
bun test src/lib/prisma-tenant.test.ts
bun test src/lib/tenant-scope-coverage.test.ts
bun test src/lib/tenant-route-guard.test.ts
bun test src/lib/invariants.test.ts
```

For the complete unit suite, use `bun run test`. These checks cover specific defenses;
they do not substitute for ownership review of raw SQL and nested relations.

See [session.ts](./src/lib/session.ts), [Multi-Tenant Architecture](./docs/multi-tenant.md),
and [AGENTS.md](./AGENTS.md) for the client-ID and tenant-entry conventions.
