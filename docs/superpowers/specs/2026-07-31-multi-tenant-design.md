# Multi-Tenant Upgrade — Design Spec

> Created 2026-07-31. Status: autonomous loop mode. User chose: shared DB + orgId, 1 user = 1 org, session-based, 3 roles per-org, self-service signup.

## Goal

Upgrade from single-tenant to multi-tenant SaaS. Every data model gets `organizationId`. Org context is auto-injected via Prisma client extension + AsyncLocalStorage. Minimal route changes needed — the extension handles scoping automatically.

## Architecture

```
Request → getActiveUser() → sets AsyncLocalStorage(orgId) → Prisma extension auto-injects orgId into all queries
                                                                    ↓
                                                         Routes stay unchanged (mostly)
                                                         New: signup, invite, users, org routes
```

## Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Isolation | Shared DB + orgId column | Simplest, works with existing Postgres, scales to thousands of orgs |
| User-Org | 1 user = 1 org, email globally unique | Simplest auth, no org switcher UI needed |
| Org resolution | Session-based (user.orgId) | No DNS/routing changes, works day 1 |
| Roles | admin \| analyst \| viewer per-org | Reuses existing role field, admin promotes manually |
| Onboarding | Self-service signup + email invite | Admin creates org, invites team |
| Auto-scoping | Prisma client extension + AsyncLocalStorage.enterWith() | Zero route changes for org scoping — extension injects orgId into all queries automatically |
| Escape hatch | bypassOrg() for SSO login, setup wizard | Queries that need no org context run without scoping |

## Schema Changes

### New models
- `Organization` — id, name, slug, brandingJson, createdAt, updatedAt
- `Invitation` — id, organizationId, email, role, token, invitedBy, status, expiresAt

### Modified models (add organizationId + @@index)
ALL 28 existing data models get:
```
organizationId String
organization   Organization @relation(...)
@@index([organizationId])
```

Not scoped: `Organization`, `Invitation` (org-level models themselves)

### Unique constraint changes
- `LlmConfig.purpose` was `@unique` → `@@unique([organizationId, purpose])`
- `User.email` stays `@unique` (globally unique — 1 user = 1 org)

## Prisma Tenant Extension (`src/lib/prisma-tenant.ts`)

- `AsyncLocalStorage<string>` stores current orgId
- `enterWith(orgId)` called by `getActiveUser()` — sets context for current request
- Prisma `$extends` query interceptor: for org-scoped models, auto-injects `organizationId` into `where` (reads) and `data` (creates)
- `bypassOrg(fn)` — runs callback without org context (SSO login, setup wizard)
- Set of org-scoped model names controls which models get auto-injection

## Session Changes (`src/lib/session.ts`)

- `ActiveUser` gets `organizationId` and `role` fields
- `getActiveUser()` queries user's orgId + role, calls `enterWith(orgId)`
- `requireRole(user, minRole)` — throws 403 if user's role is insufficient
- Role hierarchy: admin > analyst > viewer

## New Routes

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/api/auth/signup` | POST | Public | Create org + first admin user |
| `/api/auth/invite` | POST | admin | Invite user via email |
| `/api/auth/accept-invite` | POST | Public | Accept invite, set password, join org |
| `/api/org` | GET | Any | Get org info (name, slug, member count) |
| `/api/org` | PATCH | admin | Update org name/branding |
| `/api/users` | GET | admin | List org members |
| `/api/users/[id]/role` | PATCH | admin | Change user role |
| `/api/users/[id]` | DELETE | admin | Remove user from org |

## Role Access Matrix

| Route area | admin | analyst | viewer |
|-----------|-------|---------|--------|
| Integrations, LLM config, MCP, vector store | ✅ | ❌ | ❌ |
| Org settings, users, API keys | ✅ | ❌ | ❌ |
| Schedules, notifications | ✅ | ✅ | ❌ |
| Documents, chat, agent, prompts | ✅ | ✅ | ❌ |
| Dashboard, analytics, monitoring | ✅ | ✅ | ✅ |

## Seed

- Create default org "Default Organization" with slug "default"
- Existing admin user assigned to default org as admin
- All seeded data (integrations, documents, plugins, etc.) assigned to default org

## Implementation Order

1. Schema changes + `prisma db push`
2. Prisma tenant extension
3. Session changes (ActiveUser + enterWith)
4. New auth routes (signup, invite, accept-invite)
5. New management routes (org, users)
6. Role-based access control on admin routes
7. UI changes (org name, user management)
8. Seed update
9. Verify
