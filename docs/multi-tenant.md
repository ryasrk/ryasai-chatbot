# Multi-Tenant Architecture

## Overview

ryasai Chatbot is deployed on-prem per customer and supports multiple organizations within an installation. Organization-owned models carry `organizationId`. The Prisma extension scopes supported operations using AsyncLocalStorage; raw SQL and nested relation operations require explicit ownership checks.

## Architecture

- **Organization**: tenant root entity (name, slug, license info)
- **User**: belongs to one organization (email globally unique, 1 user = 1 org)
- **Invitation**: email invite to join an org (7-day token expiry)

### Tenant Isolation

Every route must call `enterWithOrg(user.organizationId)` immediately after `getActiveUser()` in the route's own frame. `enterWithOrg` accepts one string and returns `void`; `getOrgContext()` returns a string or `undefined`. The extension injects tenant predicates into supported reads and writes, including unique reads, and rejects missing context or foreign tenant IDs. Client-supplied IDs must still use `findFirst` or `findFirstOrThrow`. Model membership and pre-auth exceptions are defined in `src/lib/prisma-tenant.ts`.
Escape hatch: `bypassOrg(fn)` runs a callback without org scoping — used by SSO login, signup, setup wizard, and seed scripts.

### RBAC

Three roles per org: `admin` > `analyst` > `viewer`
- `requireRole(user, 'admin')` — throws ForbiddenError (403) if insufficient
- Applied to all configuration routes (integrations, LLM config, MCP, API keys, schedules, notifications, org settings, user management)
- All org members can view (GET routes)

### License Validation and Plans

The installation validates its machine-bound key against our central License Validator.
`getActiveUser()` enforces the org licence on authenticated requests; the scheduler consults
the same `getLockdownReason` predicate before work. `none`/`unpaid`, expired and deactivated
licences lock down work. An unreachable validator is tolerated only within the grace period.
`POST /api/webhooks/license` receives licence updates.

The commercial entitlement is `flat`. Legacy `starter`, `pro` and `enterprise` plans remain
in `src/lib/plan-gating.ts`; feature and quota checks still apply wherever wired. They are
licensing-era compatibility, not per-token billing. Customers pay their own AI providers.

### Team Management

- Admin invites users via email (POST /api/auth/invite)
- Invitee gets a token URL to set password and join (POST /api/auth/accept-invite)
- Admin can change roles and deactivate users
- UI: Settings > Team tab

### SSO

- OIDC: Keycloak, Azure AD, Auth0, Google (see docs/sso-setup.md)
- SAML 2.0: AD FS, Shibboleth, Okta SAML
- SSO provisioning uses `SSO_ORGANIZATION_ID`, or the sole existing organization when unset. No organization or multiple unselected organizations causes provisioning to fail closed.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LICENSE_VALIDATOR_URL` | License-Validator service URL (default: http://localhost:9000) |
| `LICENSE_PRODUCT` | Product identifier (default: ryasai-chatbot) |
| `LICENSE_WEBHOOK_SECRET` | Shared secret for license webhook receiver |
| `SSO_ORGANIZATION_ID` | Explicit target organization for SSO provisioning; required when multiple orgs exist |
| `OIDC_*` | OIDC SSO configuration (see sso-setup.md) |
| `SAML_*` | SAML 2.0 SSO configuration (see sso-setup.md) |
