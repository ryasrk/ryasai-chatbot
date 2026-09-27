import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard — org context must be entered in every route that calls
 * getActiveUser().
 *
 * The tenant extension only scopes queries when AsyncLocalStorage holds an
 * org id. getActiveUser() DOES call enterWithOrg() internally, but
 * AsyncLocalStorage.enterWith() mutates the *callee's* async context — it does
 * NOT propagate back to the caller's frame. Empirically verified: a route that
 * does `await getActiveUser()` and then queries the DB runs UNSCOPED — every
 * org's rows are visible (cross-tenant leak). This happened in production: 24
 * routes (documents/search, sessions/[id]/export, prompts, traces, …) leaked
 * or crashed their audit writes with `organizationId: undefined`.
 *
 * Rule enforced per route file:
 *   if the file calls getActiveUser()  →  it must also reference
 *   enterWithOrg (or bypassOrg for the rare legitimate cases, which this test
 *   allows but which should be reviewed by hand).
 */

const API_ROOT = join(import.meta.dir, '..', 'app', 'api')

function listRouteFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...listRouteFiles(full))
    else if (entry === 'route.ts') out.push(full)
  }
  return out
}

describe('tenant isolation: every authenticated route enters org context', () => {
  const routes = listRouteFiles(API_ROOT)

  test('found route files to check', () => {
    expect(routes.length).toBeGreaterThan(50)
  })

  for (const file of routes) {
    const rel = file.slice(file.indexOf('src/app'))
    test(rel, () => {
      const src = readFileSync(file, 'utf8')
      /*
       * BOTH auth mechanisms, and the second one is why this guard was incomplete.
       *
       * It tested only `getActiveUser()` (session auth). The `src/app/api/v1/**` routes authenticate with
       * `requireExternalApiKey()` instead, so they were NEVER CHECKED — and `/api/v1/agent/run` ran its DB
       * queries with no org context for exactly that reason. Measured consequence on the live database
       * (inside a transaction the audit rolled back): a FOREIGN org's document was returned.
       *
       * `requireExternalApiKey` does call `enterWithOrg` internally, which is why this looks safe when read
       * quickly — but `AsyncLocalStorage.enterWith()` does not propagate back to the caller's frame, so the
       * route's own queries stay unscoped. The route must enter the org itself, which is the rule this guard
       * now enforces for both families.
       */
      const needsOrgContext =
        /\bgetActiveUser\s*\(/.test(src) || /\brequireExternalApiKey\s*\(/.test(src)
      if (!needsOrgContext) return // nothing to guard

      const entersOrg =
        /\benterWithOrg\s*\(/.test(src) || /\bbypassOrg\s*\(/.test(src)
      expect(entersOrg).toBe(true)
    })
  }
})
