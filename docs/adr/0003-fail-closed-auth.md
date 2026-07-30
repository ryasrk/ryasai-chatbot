# ADR 0003: Fail-Closed Authentication

**Status:** Accepted  
**Date:** 2026-07-30

## Context

AI assistants with database and API access are high-value targets. An authentication failure that silently lets a user through (fail-open) could expose enterprise data to unauthenticated attackers. The demo fallback (`AUTH_DEMO_FALLBACK`) impersonates the first user — useful for local dev but dangerous in production. Many frameworks default to fail-open for better developer experience.

## Decision

Authentication fails closed. On any error, missing session, expired token, or absent config, the request is rejected with `401 Unauthorized`. The demo fallback (`AUTH_DEMO_FALLBACK`) defaults to `false`. Session version checking prevents session fixation — old cookies are rejected after re-login. 30-minute inactivity timeout enforced server-side.

## Consequences

- **Positive:** Safer default — misconfiguration cannot accidentally grant access. Session fixation defense via `sessionVersion` + HMAC. Clear security posture for enterprise buyers.
- **Negative:** Harder onboarding — developers must set `AUTH_DEMO_FALLBACK=true` locally or create a real user before the app is usable. A misconfigured production deployment locks everyone out (which is the safe outcome).

## Alternatives

- **Fail-open with logging:** Rejected — logging an auth bypass doesn't undo the data leak. Security incidents happen in the gap between the log entry and human response.
- **Fail-open in dev, fail-closed in prod:** Rejected — config-dependent behavior leads to dev/prod drift bugs. Same code path everywhere is safer.
