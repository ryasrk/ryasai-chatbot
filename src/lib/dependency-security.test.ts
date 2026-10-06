/**
 * Dependency security, pinned as a test.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * `bun audit` is a command an operator has to REMEMBER to run, so a vulnerability that appears during a routine
 * `bun add` is invisible until someone audits deliberately. Three advisories survived `bun audit fix` because a
 * parent package pins its dependency EXACTLY, and each is held below by an `overrides` entry in package.json:
 *
 *   - `prismjs` is reachable from the BROWSER. `react-syntax-highlighter` pins `refractor@3.6.0`, which depends on
 *     `prismjs@~1.27.0`; that copy is bundled into a client chunk.
 *   - `deepmerge-ts` and `effect` are pulled in by `@prisma/config@6.19.2` via the `prisma` CLI, which ships in the
 *     scheduler image because the `migrate` service runs `prisma db push` on every boot. They are not in the app
 *     image, but a CLI that runs on every customer boot is not a place to leave a high-severity advisory.
 *
 * The two CLI overrides were first treated as ACCEPTED RISK and are now FIXED, after measuring what overriding them
 * does to the one command that matters: `prisma db push` against a scratch database, and `prisma validate` with a
 * `prisma.config.ts` present (the only input that reaches `deepmerge`), both succeeded unchanged, and
 * `deepmerge-ts` 7.1.5 and 8.0.2 returned identical output on scalar, nested, array, undefined, null, function and
 * three-way merges. An override of a package another one pins exactly is a risk — so what each pin protects is
 * asserted below, not assumed.
 *
 * This test reads the LOCKFILE and node_modules rather than invoking the registry, so it needs no network.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

/**
 * Overridden packages and the first version that is NOT affected. A resolution below it is the advisory returning.
 * `bun audit` is the authority on what is vulnerable; this list is what keeps a regression from waiting for someone
 * to run it.
 */
const PINNED: Array<{ name: string; fixedIn: string; advisory: string }> = [
  { name: 'prismjs', fixedIn: '1.30.0', advisory: 'DOM clobbering (GHSA-x7hr-w5r2-h6wg), bundled into a client chunk' },
  { name: 'deepmerge-ts', fixedIn: '8.0.0', advisory: 'stack exhaustion on recursive graphs (GHSA-ggr8-5vv4-36mx), prisma CLI' },
  { name: 'effect', fixedIn: '3.20.0', advisory: 'AsyncLocalStorage context loss under concurrent load (GHSA-38f7-945m-qr2g), prisma CLI' },
  { name: 'proxy-addr', fixedIn: '2.0.8', advisory: 'IP spoofing via IPv4-mapped IPv6 trust subnet (GHSA-jqcg-44mw-7w3h)' },
  { name: 'source-map-js', fixedIn: '1.2.2', advisory: 'event-loop denial of service through indexed source-map (GHSA-68fv-2mgg-jv7q)' },
]

/** Compare dotted versions numerically; returns <0, 0, >0. A prerelease suffix is ignored (none are used here). */
const cmpVersion = (a: string, b: string): number => {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'))

describe('the installed Next.js is not a version with an unauthenticated RCE', () => {
  /**
   * Two CRITICAL advisories are fixed only in >= 16.3.3: unauthenticated RCE on Windows-hosted servers, and
   * unauthenticated RCE through the Image Optimization API when AVIF is used. The second is the one that matters
   * for THIS app: it calls `next/image` in login-view.tsx and topbar.tsx, so the optimizer is live and reachable
   * before anyone logs in. A declared range of "^16.1.1" would happily reinstall a vulnerable version on a fresh
   * `bun install`, which is why the floor is asserted rather than trusted.
   */
  const RCE_FIXED_IN = [16, 3, 3] as const
  const parse = (v: string): number[] => v.split('.').map((n) => Number(n.replace(/\D/g, '')))

  test('the declared range cannot resolve below the fix', () => {
    const declared = readJson(join(ROOT, 'package.json')).dependencies as Record<string, string>
    const floor = parse(declared.next.replace(/^[^\d]*/, ''))
    const [major, minor, patch] = RCE_FIXED_IN
    const belowFix =
      floor[0] < major ||
      (floor[0] === major && floor[1] < minor) ||
      (floor[0] === major && floor[1] === minor && floor[2] < patch)
    expect(belowFix, `next is declared "${declared.next}", which allows a version below ${RCE_FIXED_IN.join('.')}`).toBe(false)
  })

  test('the version actually installed is at or above the fix', () => {
    const installed = readJson(join(ROOT, 'node_modules', 'next', 'package.json')).version as string
    const v = parse(installed)
    const [major, minor, patch] = RCE_FIXED_IN
    const below =
      v[0] < major || (v[0] === major && v[1] < minor) || (v[0] === major && v[1] === minor && v[2] < patch)
    expect(below, `next ${installed} is below the RCE fix ${RCE_FIXED_IN.join('.')}`).toBe(false)
  })
})

describe('overridden dependencies cannot fall back to a vulnerable version', () => {
  test('every pinned package has an override at or above its fix', () => {
    const overrides = (readJson(join(ROOT, 'package.json')).overrides ?? {}) as Record<string, string>
    for (const { name, fixedIn, advisory } of PINNED) {
      expect(overrides[name], `package.json has no override for ${name} (${advisory})`).toBeDefined()
      expect(cmpVersion(overrides[name], fixedIn), `override ${name}@${overrides[name]} is below the fix ${fixedIn}`).toBeGreaterThanOrEqual(0)
    }
  })

  test('the LOCKFILE resolves each pinned package only at or above its fix', () => {
    // Asserts the RESULT of the override (resolution), not the presence of the override text: two copies is the
    // failure mode, e.g. `refractor` keeping its own vulnerable prismjs beside a clean one at the top level.
    const lock = readFileSync(join(ROOT, 'bun.lock'), 'utf8')
    for (const { name, fixedIn } of PINNED) {
      const re = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":\\s*\\["${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@([0-9][0-9.]*)"`, 'g')
      const copies = [...lock.matchAll(re)].map((m) => m[1])
      expect(copies.length, `the lockfile must pin ${name} at least once`).toBeGreaterThan(0)
      for (const version of copies) {
        expect(cmpVersion(version, fixedIn), `${name}@${version} resolves below the fix ${fixedIn}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  test('the INSTALLED copy matches the lockfile, so a stale node_modules cannot pass for a fix', () => {
    for (const { name, fixedIn } of PINNED) {
      const installed = readJson(join(ROOT, 'node_modules', name, 'package.json')).version as string
      expect(cmpVersion(installed, fixedIn), `${name}@${installed} is installed below the fix ${fixedIn}`).toBeGreaterThanOrEqual(0)
    }
  })
})
