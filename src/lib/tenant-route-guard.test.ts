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

describe('tenant isolation: every getActiveUser route enters org context', () => {
  const routes = listRouteFiles(API_ROOT)

  test('found route files to check', () => {
    expect(routes.length).toBeGreaterThan(50)
  })

  for (const file of routes) {
    const rel = file.slice(file.indexOf('src/app'))
    test(rel, () => {
      const src = readFileSync(file, 'utf8')
      const usesGetActiveUser = /\bgetActiveUser\s*\(/.test(src)
      if (!usesGetActiveUser) return // nothing to guard

      const entersOrg =
        /\benterWithOrg\s*\(/.test(src) || /\bbypassOrg\s*\(/.test(src)
      expect(entersOrg).toBe(true)
    })
  }
})
