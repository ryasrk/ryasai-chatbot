# Multi-Tenant Architecture

## Overview

ryasai Chatbot is a multi-tenant SaaS. Every organization has its own isolated data via `organizationId` on all data models. A Prisma client extension auto-injects the org ID into all queries using AsyncLocalStorage.

## Architecture

- **Organization**: tenant root entity (name, slug, license info)
- **User**: belongs to one organization (email globally unique, 1 user = 1 org)
- **Invitation**: email invite to join an org (7-day token expiry)

### Tenant Isolation

The Prisma tenant extension (`src/lib/prisma-tenant.ts`) uses `AsyncLocalStorage` to track the current org context. When `getActiveUser()` is called, it sets the org context via `enterWithOrg(orgId)`. Every subsequent Prisma query on org-scoped models automatically gets `organizationId` injected into the `where` clause (reads) and `data` object (creates).

Escape hatch: `bypassOrg(fn)` runs a callback without org scoping — used by SSO login, signup, setup wizard, and seed scripts.

### RBAC

Three roles per org: `admin` > `analyst` > `viewer`
- `requireRole(user, 'admin')` — throws ForbiddenError (403) if insufficient
- Applied to all configuration routes (integrations, LLM config, MCP, API keys, schedules, notifications, org settings, user management)
- All org members can view (GET routes)

### License Validation

- Signup requires a valid license key from the License-Validator service
- `getActiveUser()` checks org `licenseStatus` on every request
- Expired/invalid/suspended → 402 Payment Required
- Scheduler re-validates all org licenses daily
- Webhook receiver: POST /api/webhooks/license (for real-time revocation)

### Plan-Based Feature Gating

- Plans: starter < pro < enterprise
- `hasPlan(user.plan, 'pro')` — returns true if user's plan >= required plan
- MCP servers, schedules, agent: require pro or higher
- Limits per plan: maxUsers, maxIntegrations, maxDocuments (see `src/lib/plan-gating.ts`)

### Team Management

- Admin invites users via email (POST /api/auth/invite)
- Invitee gets a token URL to set password and join (POST /api/auth/accept-invite)
- Admin can change roles and deactivate users
- UI: Settings > Team tab

### SSO

- OIDC: Keycloak, Azure AD, Auth0, Google (see docs/sso-setup.md)
- SAML 2.0: AD FS, Shibboleth, Okta SAML
- SSO users get `organizationId: 'org-default'` by default (assign to correct org after first login)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LICENSE_VALIDATOR_URL` | License-Validator service URL (default: http://localhost:9000) |
| `LICENSE_PRODUCT` | Product identifier (default: ryasai-chatbot) |
| `LICENSE_WEBHOOK_SECRET` | Shared secret for license webhook receiver |
| `OIDC_*` | OIDC SSO configuration (see sso-setup.md) |
| `SAML_*` | SAML 2.0 SSO configuration (see sso-setup.md) |
