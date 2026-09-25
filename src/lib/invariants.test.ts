/**
 * Load-bearing invariants — static guards against regressions that AI agents
 * (or humans) introduced before. Each block documents the incident it prevents.
 *
 * These read source files as TEXT on purpose: the failure modes were all
 * "looks fine, compiles fine, silently broken at runtime" — dynamic imports
 * the bundler can't trace, a duplicate instrumentation file that shadows the
 * real one, searchType names that were never in the SDK. Only a static scan
 * (the same approach as tenant-route-guard.test.ts) catches them before merge.
 *
 * If one of these fails your change: do NOT delete the guard. Read the comment
 * above the assertion — it explains the production incident the guard encodes.
 */
import { describe, expect, test } from 'bun:test'
// Imported for the cross-lingual guard, which must assert BEHAVIOUR: a
// source-level check for the identifier `SYNONYM_REVERSE` did not fail when the
// lookup was replaced with `undefined`, so it could not catch the regression it
// was written for. Only compare the resulting expansions.
import { expandQuery } from './intent-pipeline'
import { readFileSync, existsSync, globSync } from 'node:fs'
import { join } from 'node:path'

/** `lexicalFirst(...)` called with the vector ranking among its candidates. */
const LEXICAL_FIRST_WITH_VECTOR = /lexicalFirst\([^;]*\bvectorRanking\b[^;]*\)/

const REPO_ROOT = join(import.meta.dir, '../..')

function readRepo(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

// ---------------------------------------------------------------------------
// 1. Exactly one instrumentation file, and it MUST start the BullMQ worker
// ---------------------------------------------------------------------------
// INCIDENT (2026-08): the repo had BOTH `instrumentation.ts` (root) and
// `src/instrumentation.ts`. Next.js picked the root one — an older copy that
// did NOT call startJobWorker(). Result: every document-embed/document-cognify
// job queued to Redis sat on the `wait` list forever (40 jobs, 16+ hours,
// zero processed). Documents uploaded fine but were never embedded or
// cognified, so the chatbot "did not know" any of them, and cognee searches
// threw `dataset not found` on every chat turn.
describe('invariant: single instrumentation file that starts the job worker', () => {
  test('no instrumentation.ts at the repo root (Next.js would prefer it over src/)', () => {
    expect(existsSync(join(REPO_ROOT, 'instrumentation.ts'))).toBe(false)
    expect(existsSync(join(REPO_ROOT, 'instrumentation.js'))).toBe(false)
  })

  test('src/instrumentation.ts exists and CALLS startJobWorker()', () => {
    const src = readRepo('src/instrumentation.ts')
    // NEGATIVE-CONTROLLED. The first version of this guard was
    // `expect(src).toContain('startJobWorker')`, which passed even when the CALL was deleted —
    // the name survives in the `await import('@/lib/job-processor')` destructure directly above
    // it. Verified by deleting the call: 49 pass, 0 fail, i.e. the guard proved nothing. That is
    // this repo's most expensive known failure (40 jobs stuck 16+ hours), so the guard must match
    // an INVOCATION, not the identifier.
    //
    // Strip comments first: otherwise `/* startJobWorker() */` satisfies the pattern. Then
    // require the call on a non-comment line.
    const code = src
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).toMatch(/\bstartJobWorker\s*\(\s*\)/)
    // And the import must still exist, or the call cannot resolve.
    expect(code).toContain('job-processor')
  })
})

// ---------------------------------------------------------------------------
// 2. cognee searchType values must exist in the INSTALLED SDK
// ---------------------------------------------------------------------------
// INCIDENT (2026-08): `GRAPH_ENTITIES` / `GRAPH_RELATIONSHIPS` were copied from
// Python cognee docs. The Rust SDK (@cognee/cognee-ts) rejected them with
// `validation error: unknown SearchType '…'` — two of four recall strategies failed
// on every single chat turn. The valid names were re-read from the installed SDK's
// type declaration so a rename would fail HERE instead of in production logs.
//
// AUTHORITY MOVED 2026-09-24, the guard did not get weaker. The `@cognee/cognee-ts`
// bindings were removed when this deployment moved to the cognee v1.6.0 API server, so
// the SDK type file no longer exists to read. The authority is now the SERVER's own
// OpenAPI schema, captured into a committed fixture by
// scripts/refresh-cognee-search-types.ts (CI runs no cognee sidecar, so a snapshot is
// the only way to keep this automated). The assertions below are unchanged in number
// and kind: the fixture must look real, every literal we send must be in it, and our
// local mirror must equal it in BOTH directions.
//
// The move already earned its keep: read against the v1.6.0 enum, the locally mirrored
// `FEEDBACK` does not exist server-side. It happened to be used nowhere, so no chat turn
// was broken — but that is exactly the `GRAPH_ENTITIES` shape of defect, caught here.
describe('invariant: cognee searchType literals are valid in the pinned v1.6.0 server', () => {
  const FIXTURE = 'src/lib/__fixtures__/cognee-search-types.json'

  function serverSearchTypes(): string[] {
    const raw = readRepo(FIXTURE)
    const parsed = JSON.parse(raw) as { searchTypes?: unknown; source?: unknown }
    if (!Array.isArray(parsed.searchTypes)) {
      throw new Error(`${FIXTURE}: searchTypes array missing — refresh it with scripts/refresh-cognee-search-types.ts.`)
    }
    return parsed.searchTypes as string[]
  }

  test('the fixture still describes the server enum (guard freshness)', () => {
    const types = serverSearchTypes()
    expect(types.length).toBeGreaterThanOrEqual(10)
    expect(types).toContain('SUMMARIES')
    expect(types).toContain('CHUNKS')
    // A fixture with no recorded origin cannot be audited when it disagrees with code.
    expect(readRepo(FIXTURE)).toContain('openapi.json')
  })

  test('every searchType literal in cognee-*.ts is in the server enum', () => {
    const valid = new Set(serverSearchTypes())
    const files = [
      'src/lib/cognee-memory.ts',
      'src/lib/cognee-knowledge-graph.ts',
    ] as const
    const offenders: string[] = []
    for (const f of files) {
      const src = readRepo(f)
      for (const m of src.matchAll(/searchType:\s*'([A-Z_]+)'/g)) {
        if (!valid.has(m[1])) offenders.push(`${f}: '${m[1]}'`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('COGNEE_SEARCH_TYPES in cognee-types.ts mirrors the server enum exactly', () => {
    const src = readRepo('src/lib/cognee-types.ts')
    const ours = new Set([...src.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]))
    const server = new Set(serverSearchTypes())
    // Both directions, exactly as before: a name we would SEND that the server rejects,
    // and a name the server offers that we would refuse to use.
    expect([...ours].filter((t) => !server.has(t))).toEqual([])
    expect([...server].filter((t) => !ours.has(t))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. DB drivers must load through the STATIC loader map
// ---------------------------------------------------------------------------
// INCIDENT (2026-08): `loadDriver` did `await import(name)` with a runtime
// variable. No bundler can trace that: Turbopack dev rewrote it to a chunk
// lookup that missed, and standalone output tracing dropped pg/mysql2/mssql/
// @clickhouse from node_modules entirely (standalone had 36 packages; pg was
// not one). Every data-source connection failed with "driver not installed".
// The fix is structural: a static map of `async () => import('literal')` so
// the specifier is analyzable. Never reintroduce a variable specifier.
describe('invariant: DB drivers load via static import map', () => {
  test('loadDriver resolves through DRIVER_LOADERS with literal specifiers', () => {
    const src = readRepo('src/lib/real-connectors.ts')
    expect(src).toContain('DRIVER_LOADERS')
    // The loader map must use string-literal imports only.
    const mapBlock = src.slice(
      src.indexOf('DRIVER_LOADERS'),
      src.indexOf('}', src.indexOf("'@clickhouse/client':")),
    )
    for (const m of mapBlock.matchAll(/import\(([^)]+)\)/g)) {
      expect(m[1].trim().startsWith("'")).toBe(true) // literal, not a variable
    }
  })

  test('no variable-specifier dynamic import remains in real-connectors.ts', () => {
    const raw = readRepo('src/lib/real-connectors.ts')
    // Strip comments first — the fix's own documentation legitimately mentions
    // `import(variable)` as the anti-pattern.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
    const offenders = [...src.matchAll(/import\(\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\)/g)]
      .map((m) => m[0])
    expect(offenders).toEqual([])
  })

  test('next.config.ts keeps the driver set external AND traced into standalone output', () => {
    const cfg = readRepo('next.config.ts')
    const drivers = ['pg', 'mysql2', 'mssql', 'tedious', '@clickhouse/client']
    const externalsBlock = cfg.slice(cfg.indexOf('serverExternalPackages'), cfg.indexOf(']', cfg.indexOf('serverExternalPackages')))
    const tracingBlock = cfg.slice(cfg.indexOf('outputFileTracingIncludes'), cfg.indexOf('\n  serverExternalPackages'))
    for (const d of drivers) {
      expect(externalsBlock).toContain(`"${d}"`)
      expect(tracingBlock).toContain(`node_modules/${d}/`)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. PDF extractor must never emit binary noise
// ---------------------------------------------------------------------------
// INCIDENT (2026-08): the old regex extractor only matched UNCOMPRESSED text
// operators (essentially no real PDF) and "fell back" to dumping printable
// ASCII from the raw binary. A 2.7 MB book yielded 329 chars of garbage, which
// was chunked, embedded, and served as knowledge — poisoned retrieval. The
// behavioral guarantees live in document-parsers.test.ts (FlateDecode, hex
// strings, multi-stream endstream resumption, noise-free empty result). This
// static guard only pins the fallback contract: no raw-dump fallback path.
describe('invariant: PDF parser has no binary-noise fallback', () => {
  test('document-parsers.ts contains no printable-ASCII dump fallback', () => {
    const src = readRepo('src/lib/document-parsers.ts')
    // The historic fallback was a replace() that stripped non-printable bytes
    // from the raw buffer. Any \\x20-\\x7E style printable filter is the smell.
    expect(src).not.toMatch(/\\x20-\\x7E/)
    expect(src).not.toMatch(/x20-x7e/i)
  })
})

// ---------------------------------------------------------------------------
// 5. SQL safety lists must not diverge between layers
// ---------------------------------------------------------------------------
// INCIDENT (2026-09): `assertSelectOnly` in real-connectors.ts kept its OWN
// copy of the mutation-keyword set, and that copy was missing the
// transaction-control + maintenance keywords that guardrails.ts already
// rejected. The "belt-and-suspenders" execution boundary was therefore
// STRICTLY WEAKER than the guard it was meant to back up. The same class of
// drift produced the pg_read_file hole: neither list knew about side-effecting
// FUNCTIONS at all, so `SELECT pg_read_file('/etc/passwd')` returned the DB
// host's /etc/passwd through the query route.
//
// Rule: there is exactly ONE dangerous-function list (guardrails.ts), and
// real-connectors.ts must IMPORT it rather than redeclare it.
describe('invariant: SQL guard lists are single-source', () => {
  test('real-connectors.ts imports the function deny-list instead of copying it', () => {
    const src = readRepo('src/lib/real-connectors.ts')
    expect(src).toContain("from '@/lib/guardrails'")
    expect(src).toContain('detectDangerousFunctions')
    // A local copy of the function table is the regression this guards against.
    expect(src).not.toMatch(/pg_read_file['"]?\s*[,)]/)
  })

  test('executeQuery paths call assertNoDangerousFunctions', () => {
    const src = readRepo('src/lib/real-connectors.ts')
    const calls = src.match(/assertNoDangerousFunctions\(sql\)/g) ?? []
    // One per connector executeQuery: Postgres, MySQL, MSSQL, ClickHouse.
    expect(calls.length).toBeGreaterThanOrEqual(4)
  })

  test('Postgres and MySQL enforce DB-level read-only transactions', () => {
    const src = readRepo('src/lib/real-connectors.ts')
    expect(src).toContain('SET TRANSACTION READ ONLY')
    expect(src).toContain('START TRANSACTION READ ONLY')
    // statement_timeout is what bounds pg_sleep at the server.
    expect(src).toContain('statement_timeout')
    // ClickHouse has its own read-only setting rather than transaction semantics.
    expect(src).toContain('readonly: 1')
  })

  test('guardrails.ts exposes the shared function deny-list', () => {
    const src = readRepo('src/lib/guardrails.ts')
    expect(src).toContain('export function detectDangerousFunctions')
    // Must check functions on the masked (string-literal-stripped) SQL.
    expect(src).toMatch(/maskStringLiterals/)
    for (const fn of ['pg_read_file', 'dblink', 'set_config', 'load_file', 'url']) {
      expect(src).toContain(fn)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Background workers must honour the license lockdown
// ---------------------------------------------------------------------------
// INCIDENT (2026-09): the scheduler worker executed scheduled runs for an org
// whose license was expired. Every HTTP route is gated by `getActiveUser()`,
// but the worker is a separate process that never touched that path, so a
// locked-down customer kept consuming LLM tokens and DB access unattended —
// verified by running a schedule while `licenseStatus='invalid'`.
//
// Rule: any process that executes work on behalf of an org must consult
// `getLockdownReason` before doing that work.
describe('invariant: background workers enforce the license lockdown', () => {
  test('scheduler gates job execution on getLockdownReason', () => {
    const src = readRepo('mini-services/scheduler/index.ts')
    expect(src).toContain('getLockdownReason')
    // The gate must be an early return in the job path, not just an import.
    expect(src).toMatch(/const lockdownReason = getLockdownReason\(/)
    expect(src).toMatch(/if \(lockdownReason\) \{[\s\S]*?return/)
  })

  test('scheduler does not reimplement the license predicate', () => {
    const src = readRepo('mini-services/scheduler/index.ts')
    // A second copy of the status→lockdown mapping is the drift risk this
    // guards against (same failure mode as the duplicated SQL guard lists).
    expect(src).not.toMatch(/status === 'expired'/)
    expect(src).not.toMatch(/status === 'unpaid'/)
  })

  test('license-skipped runs are recorded, not silently dropped', () => {
    const src = readRepo('mini-services/scheduler/index.ts')
    expect(src).toContain("status: 'skipped'")
  })
})

// ---------------------------------------------------------------------------
// 7. A fresh install must be able to reach the signup screen
// ---------------------------------------------------------------------------
// INCIDENT (2026-09): `getSetupState` hardcoded `setupCompleted: true` for
// anonymous callers. On a database with 0 users / 0 orgs / 0 AppConfig rows —
// exactly what `install.sh` leaves before the first signup — the client was
// told setup was already complete, so page.tsx skipped its `if
// (!setup.setupCompleted)` signup block and rendered the shell with no session.
// The deployment was unusable and no test caught it, because the test asserted
// the buggy value.
//
// Rule: the pre-login setup answer must be derived from the DB, never a
// constant, so an empty database reports "not set up".
describe('invariant: fresh install reports setup as incomplete', () => {
  test('getSetupState does not hardcode setupCompleted for anonymous callers', () => {
    const src = readRepo('src/lib/setup.ts')
    // The historic bug: a ternary whose false branch was the literal `true`.
    expect(src).not.toMatch(/setupCompleted:\s*organizationId\s*\?[^:]*:\s*true/)
    // Must actually count completed setups instead.
    expect(src).toContain('appConfig.count')
  })

  test('page.tsx gates the signup form on setupCompleted', () => {
    const src = readRepo('src/app/page.tsx')
    expect(src).toContain('!setup.setupCompleted')
    expect(src).toContain('setup.hasAdmin')
    expect(src).toContain('defaultMode="signup"')
  })
})

// ---------------------------------------------------------------------------
// 8. The SSRF test hatch can never ship to production
// ---------------------------------------------------------------------------
// `LLM_ALLOW_BLOCKED_HOSTS=true` makes isBlockedHost() return false, which is
// the guard stopping a tenant-configured LLM endpoint or REST connector from
// reaching cloud metadata IPs (169.254.x.x), localhost, and RFC1918 ranges.
// Disabling it in production is a standing SSRF vulnerability.
//
// INCIDENT (2026-09): the prod-build e2e suite (NODE_ENV=production + the
// standalone server) could not boot because env-schema refused that flag, so
// the shipped artifact had NO end-to-end coverage — the one environment every
// previous blocker had been found in was the one we never ran. The fix added an
// explicit `E2E_TEST_MODE` marker. That marker is now a security-relevant bypass
// switch, so two things must stay true forever:
//
//   1. No production manifest (Dockerfile, compose, helm, install/start scripts)
//      may set E2E_TEST_MODE or LLM_ALLOW_BLOCKED_HOSTS.
//   2. The boot guard refuses E2E_TEST_MODE on a deployment even if it leaks in.
describe('invariant: SSRF test hatch cannot ship', () => {
  // Files that define or launch a CUSTOMER deployment.
  const PRODUCTION_MANIFESTS = [
    'Dockerfile',
    'Dockerfile.scheduler',
    'docker-compose.yml',
    'install.sh',
    'start.sh',
  ]

  test('no production manifest sets the SSRF hatch or the test marker', () => {
    for (const rel of PRODUCTION_MANIFESTS) {
      if (!existsSync(join(REPO_ROOT, rel))) continue
      const src = readRepo(rel)
      expect(`${rel}:${/E2E_TEST_MODE/.test(src)}`).toBe(`${rel}:false`)
      expect(`${rel}:${/LLM_ALLOW_BLOCKED_HOSTS/.test(src)}`).toBe(`${rel}:false`)
    }
  })

  test('the helm chart does not set them either', () => {
    // helm/ lags compose, but it must never carry the bypass regardless.
    const values = existsSync(join(REPO_ROOT, 'helm/values.yaml'))
      ? readRepo('helm/values.yaml')
      : ''
    expect(values).not.toContain('E2E_TEST_MODE')
    expect(values).not.toContain('LLM_ALLOW_BLOCKED_HOSTS')
  })

  test('instrumentation.ts refuses E2E_TEST_MODE on a deployment (fails closed)', () => {
    const src = readRepo('src/instrumentation.ts')
    // Must call the shared predicate (not re-derive it) and must EXIT, not warn —
    // a silent SSRF bypass is precisely the failure mode this guards.
    expect(src).toContain('shouldRefuseBootForTestMode')
    expect(src).toMatch(/shouldRefuseBootForTestMode[\s\S]{0,900}?process\.exit\(1\)/)
    // The predicate itself must live in a testable module, not inline here.
    expect(readRepo('src/lib/env-schema.ts')).toContain('export function shouldRefuseBootForTestMode')
  })

  test('env-schema refuses the hatch in production without the explicit marker', () => {
    const src = readRepo('src/lib/env-schema.ts')
    // The refine must still consider NODE_ENV=production, and must require the
    // E2E_TEST_MODE opt-in rather than inferring test mode from NODE_ENV.
    expect(src).toMatch(/NODE_ENV !== 'production'/)
    expect(src).toContain("process.env.E2E_TEST_MODE === 'true'")
    // The old dangerous shape (hatch accepted whenever not production) must not return.
    expect(src).not.toMatch(/LLM_ALLOW_BLOCKED_HOSTS[\s\S]{0,300}?v !== 'true' \|\| process\.env\.NODE_ENV !== 'production',\n/)
  })

  test('a prod-build e2e config exists so the shipped artifact is always tested', () => {
    // The whole point of the marker: the production build gets e2e coverage.
    expect(existsSync(join(REPO_ROOT, 'playwright.prod.config.ts'))).toBe(true)
    const cfg = readRepo('playwright.prod.config.ts')
    expect(cfg).toContain("NODE_ENV=production")
    expect(cfg).toContain('.next/standalone/server.js')
    expect(cfg).toContain('E2E_TEST_MODE=true')
  })
})

describe('invariant: plan quotas are enforced, not decorative', () => {
  // PLAN_FEATURES shipped for a long time with maxUsers/maxIntegrations/
  // maxDocuments checked NOWHERE — the tiers were advertising limits that no
  // code imposed. These guards assert the enforcement is still wired at each
  // creation path, so the numbers cannot silently become decoration again.

  test('the quota helper exists and is a pure predicate (no db import)', () => {
    const src = readRepo('src/lib/plan-gating.ts')
    expect(src).toContain('export function checkQuota')
    expect(src).toContain('export function quotaFor')
    expect(src).toContain('export function quotaExceededMessage')
    // Purity matters: this module is imported by client components and tests.
    // A `db` import here would drag Prisma into the client bundle.
    expect(src).not.toMatch(/from '\.\/db'|from '@\/lib\/db'|new PrismaClient/)
  })

  test('an unknown plan falls back to the MOST restrictive tier', () => {
    const src = readRepo('src/lib/plan-gating.ts')
    // Must be starter, never flat/enterprise — a typo'd plan must not unlock the
    // biggest quotas.
    expect(src).toMatch(/PLAN_FEATURES\[plan\] \?\? PLAN_FEATURES\.starter/)
    expect(src).not.toMatch(/PLAN_FEATURES\[plan\] \?\? PLAN_FEATURES\.(flat|enterprise)/)
  })

  test('every creation path consults checkQuota', () => {
    const paths: Array<[string, string, string]> = [
      ['src/app/api/integrations/route.ts', 'maxIntegrations', 'user.plan'],
      ['src/app/api/documents/route.ts', 'maxDocuments', 'user.plan'],
      // accept-invite has no session: the plan must come from the ORG row, not
      // from a caller-supplied user object.
      ['src/app/api/auth/accept-invite/route.ts', 'maxUsers', 'org.licensePlan'],
    ]
    for (const [file, key, planExpr] of paths) {
      const src = readRepo(file)
      expect(src, `${file} must import checkQuota`).toContain('checkQuota')
      // Assert on the INVOCATION, not on the presence of a name or a string.
      // An earlier version of this guard only looked for 'QUOTA_EXCEEDED' and
      // was satisfied by a disabled `if (false)` that still contained it —
      // the guard passed while the limit was unenforced.
      expect(src, `${file} must actually CALL checkQuota with ${key}`).toContain(
        `checkQuota(${planExpr}, '${key}'`,
      )
      // A check whose result is ignored is not a check.
      expect(src, `${file} must branch on the decision`).toMatch(/if \(!quota\.allowed\)/)
      expect(src, `${file} must refuse with 402`).toContain('status: 402')
    }
  })

  test('the quota decision is never hardcoded to allowed', () => {
    // Directly pins the bypass found above: a literal `{ allowed: true }`
    // standing in for the real predicate must not satisfy these routes.
    for (const f of [
      'src/app/api/integrations/route.ts',
      'src/app/api/documents/route.ts',
      'src/app/api/auth/accept-invite/route.ts',
    ]) {
      const src = readRepo(f)
      expect(src, `${f} must not stub the quota decision`).not.toMatch(
        /const quota\s*=\s*\{\s*allowed:\s*true/,
      )
    }
  })

  test('the integration quota is checked BEFORE the connection test', () => {
    // Otherwise an over-quota create still pays a round-trip to the customer's
    // database, and the operator sees "Connection failed" instead of the ceiling.
    const src = readRepo('src/app/api/integrations/route.ts')
    const quotaIdx = src.indexOf("checkQuota(user.plan, 'maxIntegrations'")
    const connectIdx = src.indexOf('connector.fetchSchema()')
    expect(quotaIdx).toBeGreaterThan(-1)
    expect(connectIdx).toBeGreaterThan(-1)
    expect(quotaIdx).toBeLessThan(connectIdx)
  })

  test('signup and register are NOT quota-gated (they create a brand-new org)', () => {
    // Guarding these would lock a new customer out of their own first user.
    // Pin the reasoning so a future "add the check everywhere" sweep does not
    // break onboarding.
    for (const f of ['src/app/api/auth/signup/route.ts', 'src/app/api/auth/register/route.ts']) {
      const src = readRepo(f)
      expect(src, `${f} must not gate the first user on maxUsers`).not.toMatch(/checkQuota\([^)]*'maxUsers'/)
    }
  })
  // -------------------------------------------------------------------------
  // INCIDENT (2026-09 trial): the bot disclaimed answers it had retrieved.
  //
  // User report: "the LLM sometimes says it doesn't know even though the answer
  // IS in the knowledge base, and it answers once you name the source."
  //
  // Measured cause (reproduced against live Postgres, see trial/06-verify-fix.ts):
  // a document whose text extraction produced nothing is stored as
  // "[Empty document: x.pdf]" so retrieval can still match the filename. That
  // 46-char placeholder was then fed to the answer prompt AS EVIDENCE. A
  // length-based sufficiency shortcut ("< 50 chars => insufficient", with no LLM
  // call) judged it insufficient, which advanced retrieval to a second pass,
  // which set retrievalPasses >= 2, which made tool-branches.ts inject
  // "...If the evidence doesn't contain the answer, say so." The model then
  // correctly obeyed an instruction to disclaim. Naming the source changed the
  // ranking, so the note disappeared - exactly the reported asymmetry.
  //
  // TWO defects, both pinned below: placeholders treated as evidence, and
  // length used as a proxy for sufficiency.
  // -------------------------------------------------------------------------
  /** Source with comments stripped — guards must read CODE, never prose. */
  function codeOnly(rel: string): string {
    return readRepo(rel)
      .split('\n')
      // Not a JS parser: drop whole-line comments and anything after `//`.
      // Enough for these guards, and it prevents the trap below.
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
  }

  test('placeholder chunks are excluded from answer evidence', () => {
    // Assert the MECHANISM (the filter is applied), not a reason string, so a
    // future refactor that keeps the string but drops the filter still fails.
    const src = codeOnly('src/lib/intent-pipeline.ts')
    // `[^)]*` cannot bridge the `)` in `.slice(0, args.topK)`, so anchor on the
    // statement and require the filter wherever it sits on that line.
    expect(src).toMatch(/^\s*const evidenceChunks = .*filter\(.*isPlaceholderChunk/m)
  })

  test('sufficiency is NOT decided by evidence length alone', () => {
    // A short chunk is not a bad chunk: "Tarif lembur hari kerja 1,5x upah per
    // jam." is 41 chars and a complete answer. Any `evidence.length < N`
    // short-circuit makes the pipeline disclaim answers it holds.
    //
    // Scanned over CODE ONLY: the inline comment above the fix quotes the old
    // expression verbatim (that is what makes the incident legible), and a
    // regex over raw source would match that prose and fail a correct file.
    const src = codeOnly('src/lib/intent-pipeline.ts')
    expect(src).not.toMatch(/evidence\.trim\(\)\.length\s*<\s*\d+/)
    expect(src).not.toMatch(/evidence\.length\s*<\s*\d+/)
  })

  test('evidence-emptiness checks precede the LLM-availability gate', () => {
    // A deployment with no LLM configured must still refuse to call empty or
    // placeholder-only evidence "confident". When the guards sat below the
    // `if (!cfg) return { confident: true }` early-return they were unreachable
    // without an LLM — a bug in the first version of this very fix, caught only
    // because tests were written for a previously untested function.
    const src = codeOnly('src/lib/intent-pipeline.ts')
    const fnStart = src.indexOf('export async function evaluateAnswerConfidence')
    expect(fnStart).toBeGreaterThan(-1)
    const body = src.slice(fnStart, fnStart + 1400)
    const placeholderIdx = body.indexOf('isPlaceholderChunk(args.evidence)')
    const llmGateIdx = body.indexOf('if (!cfg)')
    expect(placeholderIdx).toBeGreaterThan(-1)
    expect(llmGateIdx).toBeGreaterThan(-1)
    expect(placeholderIdx).toBeLessThan(llmGateIdx)
  })

  test('query expansion bridges Indonesian -> English (cross-lingual retrieval)', () => {
    // Asserting BEHAVIOUR, not identifiers: an earlier version of this guard only
    // asserted that the string `SYNONYM_REVERSE` appeared in the source, and it
    // did NOT fail when the lookup was neutered to `undefined`. A guard that
    // cannot fail on the regression it targets is worse than none.
    const id = expandQuery('Berapa tarif lembur pada hari kerja?')
    expect(id.length).toBeGreaterThan(1)
    expect(id.some((e) => e.includes('overtime'))).toBe(true)
    // The translated variant must not leave Indonesian content words behind for
    // these known concepts, or it matches nothing in an English corpus.
    const translated = id.find((e) => e.includes('overtime') && e.includes('rate'))
    expect(translated).toBeDefined()
    expect(translated).not.toMatch(/tarif|lembur/)

    // Ambiguity: "hari" is `day`'s exact synonym but also sits inside "hari
    // libur" (holiday). It must resolve to `day`.
    const amb = expandQuery('Berapa hari proses refund?')
    const ambT = amb.find((e) => e.includes('processing'))
    expect(ambT).toBeDefined()
    expect(ambT).toContain('day')
    expect(ambT).not.toContain('holiday')

    // No duplicates, and the original query appears exactly once.
    expect(new Set(id).size).toBe(id.length)
    expect(id.filter((x) => x === 'Berapa tarif lembur pada hari kerja?').length).toBe(1)
  })

  test('query expansion reverse index is DERIVED from the forward map', () => {
    // INCIDENT (2026-09 cross-lingual trial): `expandQuery` only looked up
    // QUERY_SYNONYMS[token] — an ENGLISH-keyed map — so an Indonesian query was
    // returned unchanged. With no embedding provider configured, lexical matching
    // is the only path, so Indonesian questions against English documents
    // retrieved NOTHING. Measured: 5 of 11 Indonesian questions returned 0 chunks
    // with the answer present in the corpus (58% overall, 100% for English).
    // The reverse index must exist and must be DERIVED from the same map so the
    // two directions cannot drift.
    // Both directions must come from ONE table, so they cannot drift.
    const src = codeOnly('src/lib/intent-pipeline.ts')
    expect(src).toMatch(/SYNONYM_REVERSE[\s\S]{0,500}Object\.entries\(QUERY_SYNONYMS\)/)
    expect(src).toContain('PRIMARY_SYNONYM')
  })

  test('embedding dimension is not hardcoded to one provider', () => {
    // FINDING (2026-09 local-embedding trial): `DocumentChunk.embedding` is
    // declared `vector(1536)` and `prisma/schema.prisma` pins it there, but
    // `pgvectorSimilaritySearch` casts the query vector to `::vector` and matches
    // it against that column. Any embedding model whose dimension is not 1536
    // therefore cannot be stored in the column the vector leg actually queries,
    // and the app degrades to `embeddingJson` + a cosine fallback — silently, with
    // only a console warning.
    //
    // Measured with a local 384-dim multilingual model (no OpenAI key available):
    //   - embedDocumentChunks reported embedded=28 for every document, yet
    //     DocumentChunk.embedding stayed NULL for all 28 rows.
    //   - `semanticSimilarity` WAS populated (0.27-0.67) from the JSON fallback,
    //     but ranking was unchanged, because the vector leg returned an EMPTY
    //     candidate set and RRF then fused BM25 with nothing.
    //   - On 5 paraphrase/no-shared-token questions the result was 0/5 hits with
    //     embeddings ON and 0/5 with them OFF — i.e. a configured, "working"
    //     embedding pipeline contributed nothing to ranking.
    // This guard fails if the dimension is ever hardcoded in a way that only
    // serves one provider, or if the warning that documents the degradation is
    // removed while the mismatch remains possible.
    const schema = codeOnly('prisma/schema.prisma')
    const declaresFixedDim = /embedding\s+Unsupported\("vector\(\d+"\)\)|vector\(\d+\)/.test(schema)
    if (declaresFixedDim) {
      // If a fixed dimension is declared, the code MUST at least keep telling the
      // operator, with the exact remediation, or this breaks invisibly on any
      // other model.
      const emb = codeOnly('src/lib/embeddings.ts')
      expect(emb).toContain('pgvector search is disabled until the column matches')
      expect(emb).toMatch(/ALTER TABLE "DocumentChunk" DROP COLUMN embedding/)
    }
  })

  test('semantic similarity is not silently discarded from ranking', () => {
    // The retrieval engine must fold the vector leg into the fused ranking. The
    // dead `applyVectorStoreScore`/`scoreChunkWithEmbedding` helpers in rag.ts
    // have NO production callers (only a test mock), so grepping for them proves
    // nothing — assert on the module that actually orders results.
    const src = codeOnly('src/lib/rag-retrieval.ts')
    // ASSIGNMENT, not mere mention: asserting that the identifier `vectorRanking`
    // appears somewhere passed even after it was deleted from the fusion — a guard
    // that cannot fail on its own regression. Require `vectorRanking` to be inside the
    // candidate list handed to `lexicalFirst`, the function that orders results.
    expect(src).toMatch(LEXICAL_FIRST_WITH_VECTOR)
    expect(src).toMatch(/const vectorScore = vectorScores\.get\(id\)/)
  })

  test('the fusion guard above still rejects the regressions it was written for', () => {
    // Negative control, so the pattern cannot quietly degrade into "matches anything".
    const pattern = LEXICAL_FIRST_WITH_VECTOR
    // ACCEPTED: the shape production uses, with and without the graph leg.
    expect('const fused = lexicalFirst(toRanking(bm25), [...vectorRanking, ...(args.kgRanking ?? [])])').toMatch(pattern)
    expect('const fused = lexicalFirst(toRanking(bm25), vectorRanking)').toMatch(pattern)
    // REJECTED: the vector leg is computed but not passed.
    expect('const fused = lexicalFirst(toRanking(bm25), [...(args.kgRanking ?? [])])').not.toMatch(pattern)
    // REJECTED: the combining call is gone entirely.
    expect('const fused = toRanking(bm25Rank(queryTokens, docs))').not.toMatch(pattern)
    // REJECTED: a different function that merely mentions the vector ranking.
    expect('const fused = mergeRankings(toRanking(bm25), vectorRanking)').not.toMatch(pattern)
  })

  test('the alignment gate runs on BOTH agentic loops before returning an answer', () => {
    // INCIDENT (2026-09 audit): the streaming agentic loop checked alignment
    // INSIDE its substantial-evidence branch, but the non-streaming loop RETURNED
    // from that same branch before reaching its own check. The identical question
    // was guarded over SSE and UNGUARDED over HTTP, and docs/threat-model.md
    // claimed both paths were covered. No test noticed — the existing suite only
    // covered `checkAlignment` itself, never its call sites.
    const src = codeOnly('src/lib/tool-router-agentic.ts')
    // The shared helper must exist and be the ONLY thing that calls checkAlignment
    // from this module (a second inline copy is how the paths diverged).
    expect(src).toContain('alignmentNoteFor')
    expect(src).toMatch(/async function alignmentNoteFor/)
    // Both loops must invoke the helper.
    const helperCalls = src.match(/await alignmentNoteFor\(/g) ?? []
    expect(helperCalls.length).toBeGreaterThanOrEqual(2)
    // The non-streaming heuristic return must be gated BEFORE it returns: assert
    // the helper call appears between the heuristic log line and that `return`.
    const heuristicIdx = src.indexOf('Agentic loop confident (heuristic: substantial evidence)')
    expect(heuristicIdx).toBeGreaterThan(-1)
    const afterHeuristic = src.slice(heuristicIdx, heuristicIdx + 900)
    expect(afterHeuristic).toMatch(/await alignmentNoteFor\(/)
  })

  test('ALIGNMENT_CHECK is read through one predicate, never a string comparison', () => {
    // The schema declares the enum ['http','llm','disabled']; the old call sites
    // compared against 'true', so the SCHEMA-VALID value `llm` silently disabled
    // the guardrail. Scanning for the raw comparison is the only way to catch a
    // reintroduced divergence, because the enum itself looks correct.
    for (const rel of ['src/lib/tool-router-agentic.ts', 'src/lib/alignment-check.ts']) {
      const src = codeOnly(rel)
      expect(src).not.toMatch(/process\.env\.ALIGNMENT_CHECK\s*===\s*'true'/)
    }
  })

  test('client-supplied ids are never loaded with findUnique outside the allowlist', () => {
    // INCIDENT (2026-09 audit): `findUnique` is NOT org-scoped (see the long
    // comment in prisma-tenant.ts), so loading a row by a CLIENT-SUPPLIED id with
    // it is a cross-tenant IDOR. Verified exploitable in two routes:
    //   - api/mcp/servers/[id]   GET/PATCH/DELETE  (list route returns `id: true`,
    //     so ids are NOT secret and the "cuid is random" defence is void)
    //   - chat/sessions/[id]/send  body.promptId injected another org's prompt
    // Both already called getActiveUser()+enterWithOrg(), so tenant-route-guard's
    // ritual check passed — the org context was established and then ignored.
    //
    // These files are allowed because the id is NOT client-supplied, or is
    // validated by an org-scoped query first:
    const ALLOWED = new Set([
      // pre-auth: no org context exists yet (login/signup/invite/setup).
      'src/app/api/auth/login/route.ts',
      'src/app/api/auth/register/route.ts',
      'src/app/api/auth/signup/route.ts',
      'src/app/api/auth/accept-invite/route.ts',
      'src/app/api/auth/invite/route.ts',
      'src/app/api/auth/change-password/route.ts',
      'src/app/api/auth/activate-license/route.ts',
      'src/app/api/setup/status/route.ts',
      // re-reads a row the SAME handler just created, not a client id.
      'src/app/api/documents/route.ts',
      // validates via an org-scoped findFirst BEFORE the unscoped read.
      'src/app/api/integrations/[id]/init-context/route.ts',
      // id comes from the session/order, and the handlers re-scope by org.
      'src/app/api/agent/dashboard/route.ts',
      'src/app/api/billing/orders/route.ts',
      'src/app/api/billing/webhook/route.ts',
      'src/app/api/license/retry/route.ts',
      'src/app/api/org/license/route.ts',
      'src/app/api/org/route.ts',
    ])
    const routeFiles = globSync('src/app/api/**/route.ts').filter((rel) =>
      readFileSync(join(REPO_ROOT, rel), 'utf8').includes('findUnique'),
    )
    const offenders = routeFiles.filter((rel) => !ALLOWED.has(rel))
    expect(offenders).toEqual([])

    // ---------------------------------------------------------------------
    // AND THE LIBRARIES THE ROUTES DELEGATE TO.
    //
    // The check above globbed ONLY `api/**/route.ts`, and that blind spot was not
    // theoretical: two live cross-tenant IDORs sat one level down in `src/lib` and
    // this guard stayed green for both.
    //   - `prompt-library.getPrompt` used `findUnique`, reached from
    //     `api/prompts/[id]` GET/PUT/DELETE. `GET /api/prompts` hands out every
    //     prompt id, so any tenant could read, rewrite or delete another's prompt.
    //   - `doc-versioning.createDocVersion` and `restoreDocVersion` used
    //     `db.document.findUnique`, so a cross-tenant id reached a DESTRUCTIVE
    //     write.
    // A route cannot be cleared by pushing its unscoped read into a helper.
    //
    // Scanning all of `src/lib` would flag a large number of legitimate uses
    // (`findUnique` on a session id, a licence row, a webhook id that was already
    // validated by an org-scoped findFirst), so the rule is deliberately the NARROW
    // one that would have caught both incidents: a lib module that a ROUTE imports
    // AND that reads an ORG-SCOPED model by unique key is a finding, because the
    // only way such a read can be safe is if the caller re-scoped it first — which
    // is exactly the assumption that failed twice.
    const ORG_SCOPED_MODELS = [
      'savedPrompt',
      'document',
      'documentChunk',
      'documentVersion',
      'chatSession',
      'restApiConnector',
      'restApiEndpoint',
    ]
    const LIB_ALLOWED = new Set([
      // The org context is established BY these reads' callers, and the model is
      // not one a client id addresses. Re-scoped reads use findFirst.
      'src/lib/session.ts',
      'src/lib/prisma-tenant.ts',
      'src/lib/sso.ts',
      'src/lib/auth.ts',
      // The org-resolving read in `resolveJobOrg` is unscoped BY NECESSITY: it runs before any org context exists
      // (BullMQ workers are outside request AsyncStorage) and its whole purpose is to DISCOVER the org to enter. It
      // is wrapped in `bypassOrg`, reads only `organizationId`, and hands the value to `enterWithOrg`. Scoping it
      // would make it return null and re-create the unscoped-job bug it exists to prevent. Its OTHER read -- the
      // one in the `document-cognify` handler -- was changed to findFirst, and this entry is why that distinction
      // is worth writing down rather than leaving to whoever reads it next.
      'src/lib/job-processor.ts',
    ])
    const libFindings: string[] = []
    for (const rel of globSync('src/lib/**/*.ts')) {
      if (rel.endsWith('.test.ts') || LIB_ALLOWED.has(rel)) continue
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8')
      if (!src.includes('findUnique')) continue
      // Comments stripped first: a module that EXPLAINS in prose why it stopped using `findUnique` must not be
      // flagged for saying the word. This cost a false positive on the very file fixed by the change above.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      // Imported by any route?
      const importedByARoute = globSync('src/app/api/**/route.ts').some((routeRel) =>
        readFileSync(join(REPO_ROOT, routeRel), 'utf8').includes('@/lib/' + rel.replace(/^src\/lib\//, '').replace(/\.ts$/, '')),
      )
      if (!importedByARoute) continue
      for (const model of ORG_SCOPED_MODELS) {
        // `db.<model>.findUnique` on an org-scoped model.
        if (new RegExp('db\\.' + model + '\\.findUnique').test(code)) {
          libFindings.push(`${rel}: db.${model}.findUnique`)
        }
      }
    }
    expect(libFindings).toEqual([])
  })

  test('BYOK provider failures are classified, and the raw body never reaches a client', () => {
    // ryasai is bring-your-own-key: the API key belongs to the CUSTOMER, so a
    // provider rejection can only be fixed by them. Two rules follow, and both
    // were violated before this guard:
    //   1. the failure must be CLASSIFIED, because "provider is not configured"
    //      is wrong and unhelpful when the URL/model are fine and only the key
    //      is dead (revoked, out of credit, renamed model);
    //   2. the raw provider body must NOT reach the client — it can echo the
    //      key prefix.
    // Guard against a second, weaker copy of the mapping appearing: the
    // classification must live in llm-client-utils and be consumed through
    // toTypedError.
    const utils = readFileSync(join(REPO_ROOT, 'src/lib/llm-client-utils.ts'), 'utf8')
    expect(utils).toContain('export function classifyProviderFailure')
    expect(utils).toContain('export class LlmProviderError')

    const errors = codeOnly('src/lib/errors.ts')
    expect(errors).toContain('e instanceof LlmProviderError')
    // The raw `e.message` must not be the fallback for a provider error.
    expect(errors).not.toMatch(/instanceof LlmProviderError[\s\S]{0,200}message:\s*e\.message/)

    // The transport must classify every provider rejection rather than throwing
    // a bare Error, or the branch above is unreachable.
    const client = codeOnly('src/lib/llm-client.ts')
    expect(client).not.toMatch(/throw new Error\(`LLM (stream )?error \(HTTP/)
    expect(client).toContain('providerError(')

    // Chat streaming must prefer the classified hint over the generic
    // "not configured" text.
    const send = codeOnly('src/app/api/chat/sessions/[id]/send/route.ts')
    expect(send).toContain('instanceof LlmProviderError')

    // The external API's streaming path previously streamed the raw message.
    const v1 = codeOnly('src/app/api/v1/chat/completions/route.ts')
    expect(v1).toContain('toTypedError')
  })

  test('every generateSql caller passes the admin business context', () => {
    // INCIDENT (2026-09 audit): `ai.ts` renders args.businessContext into the
    // SQL-generation prompt, and stream-preparers.ts has always passed it — but
    // tool-branches.ts (the NON-STREAMING branch: scheduled runs, the agentic
    // loop, /api/v1) and api/integrations/[id]/query (the SQL Playground) did
    // not. The identical question therefore produced different SQL depending on
    // the transport, and the admin-authored business context was silently
    // dropped on every non-streaming path. This is the same transport-drift
    // class as the alignment bypass above, so it gets the same kind of guard:
    // assert the ARGUMENT is present at each call site, not that the string
    // "businessContext" exists somewhere.
    const callers = [
      'src/lib/stream-preparers.ts',
      'src/lib/tool-branches.ts',
      'src/app/api/integrations/[id]/query/route.ts',
    ]
    for (const rel of callers) {
      const src = readFileSync(join(REPO_ROOT, rel), 'utf8')
      // Find each generateSql({ ... }) block and require businessContext inside it.
      const blocks = src.match(/generateSql\(\{[\s\S]*?\}\)/g) ?? []
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) {
        expect(block).toMatch(/businessContext\s*:/)
      }
    }
  })

  test('the placeholder marker has exactly one definition and one detector', () => {
    // The marker string was inline in the upload route with no shared
    // predicate, so the producer and the consumer could drift - the same
    // duplicated-logic pattern behind every other incident in this file.
    const chunking = readRepo('src/lib/rag-chunking.ts')
    expect(chunking).toContain('EMPTY_DOCUMENT_MARKER')
    expect(chunking).toContain('export function isPlaceholderChunk')
    expect(chunking).toContain('export function emptyDocumentContent')

    const upload = readRepo('src/app/api/documents/route.ts')
    expect(upload).toContain('emptyDocumentContent(')
    expect(upload).not.toMatch(/`\[Empty document: /)
  })
})

describe('invariant: HNSW filter truncation stays handled', () => {
  // INCIDENT (2026-09 audit): a query asking pgvector for N neighbours returned
  // ZERO when the org was a minority of the shared DocumentChunk table. HNSW
  // applies the WHERE clause AFTER its approximate scan, so the scan walks the
  // GLOBAL nearest-neighbour graph and the org filter discards nearly all of
  // it. Measured (trial/98, pgvector 0.6.0, 20k vectors across 100 orgs, each
  // 1% of the table, LIMIT 20):
  //
  //   hnsw_probe (HNSW index)  ->  0 rows
  //   hnsw_exact (no index)    -> 20 rows     <- identical table, same query
  //   ef_search=1000 (max)     ->  5 rows
  //
  // The failure was invisible: `pgScores.size > 0` counted as success, so a
  // partial (or empty) vector leg silently won, the exact external vector store
  // was never consulted, and fusion treated the survivors as the whole
  // candidate set. `hnsw.iterative_scan` (pgvector 0.8.0+) is the real fix;
  // this installation runs 0.6.0, so the code must probe for it and treat a
  // short result as a failure in the meantime.
  test('an under-filled vector leg is not mistaken for success', () => {
    const src = readRepo('src/lib/rag-retrieval.ts')

    // The old bug in one line: any non-empty result returned immediately.
    expect(src).not.toMatch(/if \(pgScores\.size > 0\) return pgScores/)

    expect(src).toContain('MIN_VECTOR_LEG_ROWS')
    expect(src).toMatch(/pgScores\.size >= Math\.min\(wanted, MIN_VECTOR_LEG_ROWS\)/)
  })

  test('ef_search is raised and iterative_scan is probed, never assumed', () => {
    const src = readRepo('src/lib/rag-retrieval.ts')

    // Leaving ef_search at the server default (40) is the bug: it must scale
    // with the requested limit...
    expect(src).toMatch(/hnsw\.ef_search/)

    // ...and iterative_scan must be PROBED, because issuing an unknown GUC on
    // pgvector 0.6.x raises 42704 and would break every retrieval query.
    expect(src).toContain('hasIterativeScan')
    expect(src).toMatch(/SHOW hnsw\.iterative_scan/)
    // The probe caches: one round trip per process, not per query.
    expect(src).toMatch(/_iterativeScanSupported !== null/)
  })
})

describe('invariant: streaming preparers never leak an LLM failure', () => {
  // INCIDENT (2026-09): `prepareSqlStream` called `generateSql()` OUTSIDE its
  // try/catch — only the SQL EXECUTION was guarded. So an LLM failure (provider
  // down, dead BYOK key, timeout — all of which throw) escaped the preparer
  // entirely. By that point the caller has already promised the client an SSE
  // stream, so the turn died with the connection open and ZERO frames sent: the
  // UI showed nothing at all, not even an error message.
  //
  // This is the BYOK failure mode that matters most in this product — the
  // credential belongs to the customer, so a dead key is a routine event, not an
  // operator misconfiguration. Found by stream-preparers.test.ts, the first test
  // that had ever exercised this path.
  test('every prepare*Stream wraps its LLM call', () => {
    const src = readRepo('src/lib/stream-preparers.ts')

    // The specific regression: a bare `await generateSql(` with no enclosing try.
    // Assert the call site is preceded by a `try {` before any other statement
    // boundary — a coarse but effective shape check, paired with the behavioural
    // test in stream-preparers.test.ts that actually throws from generateSql.
    const genIdx = src.indexOf('candidate = await generateSql(')
    expect(genIdx, 'generateSql call site must exist').toBeGreaterThan(-1)
    const before = src.slice(Math.max(0, genIdx - 400), genIdx)
    expect(before).toMatch(/try\s*\{/)

    // The same class of bug in the other preparers: an `await` of an LLM helper
    // must not sit outside a try. `generateRestCall` already was guarded; keep it
    // that way.
    const restIdx = src.indexOf('generateRestCall(')
    if (restIdx > -1) {
      const restBefore = src.slice(Math.max(0, restIdx - 400), restIdx)
      expect(restBefore).toMatch(/try\s*\{/)
    }
  })

  test('a thrown generateSql is retried, not propagated', () => {
    const src = readRepo('src/lib/stream-preparers.ts')
    // The catch must feed the message into lastSqlError and continue, so the
    // repair loop can recover from a transient provider blip.
    expect(src).toMatch(/catch\s*\(e\)\s*\{\s*\/\/[^\n]*\n[^\n]*lastSqlError\s*=/)
    expect(src).toContain('continue')
  })
})

describe('AsyncLocalStorage::enterWith is never relied on from a test hook', () => {
  // INCIDENT: nine tests in knowledge-graph.test.ts failed on Bun 1.4.2 while passing on
  // 1.3.14, and the tests were not at fault. A minimal probe on 1.4.2 showed that
  // `AsyncLocalStorage.enterWith()` called inside `beforeEach` does not reach the test
  // body at all -- not even a synchronous one, and not across `await`:
  //
  //   beforeEach(() => { als.enterWith('HOOK') })
  //   test('A', () => als.getStore())   // undefined on 1.4.2
  //
  // The same call made INSIDE the test works on both versions. Because the org context
  // is what makes every org-scoped guard do any work, the failure surfaced far from the
  // cause: getOrgContext() returned undefined, the guard bailed out early, and the
  // assertion reported `Expected: 1, Received: 0` as though the product were broken.
  //
  // This is a RUNTIME behaviour we depend on, so it is not enough to fix the two files
  // that happened to fail: any new test that enters an org from a hook reintroduces the
  // same silent breakage. CI pins `bun-version: latest`, so the version that breaks it is
  // the one CI runs.
  //
  // The rule enforced here: a file that enters an org context must do it inside a test
  // body (directly, or through a helper the body calls), not from a hook.
  const ORG_FILES = new Bun.Glob('src/**/*.test.ts')
  // Anchored to the hook header and stopped at the FIRST matching close brace, so a hook
  // that does NOT call enterWith (job-processor's state reset) cannot be dragged in by a
  // later hook's body. Comments are stripped first: this guard's own explanation quotes
  // the pattern it forbids, and matching that would make the guard fail on itself.
  // The body group may not contain another hook header: without that, a hook that does NOT
  // call enterWith is matched across a LATER hook's body (job-processor's state reset was
  // dragged in exactly that way), reporting a file that is doing nothing wrong.
  const HOOK_RE = /before(?:Each|All)\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{((?:(?!before(?:Each|All)\s*\()[\s\S])*?)^\s*\}\)/gm

  test('no hook calls enterWithOrg (or enterWith) directly', async () => {
    const offenders: string[] = []
    for await (const f of ORG_FILES.scan()) {
      if (f.endsWith('invariants.test.ts')) continue
      const src = (await Bun.file(f).text())
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      if (!src.includes('enterWith')) continue
      for (const m of src.matchAll(HOOK_RE)) {
        // Entering a REAL org from a hook is the bug. Clearing the context is the opposite
        // and is legitimate: job-processor.test.ts passes an explicit NO_ORG sentinel
        // (documented there) so "no org" is a genuine undefined rather than an empty string.
        const body = m[1]
        const calls = [...body.matchAll(/\benterWith\w*\s*\(([^)]*)\)/g)]
        for (const c of calls) {
          const arg = c[1].trim()
          if (arg === '') continue
          if (/^(NO_ORG|undefined|null)$/.test(arg)) continue
          offenders.push(f)
        }
      }
    }
    expect(
      offenders,
      'enterWith() in a test hook does nothing on Bun 1.4.2 — call it inside the test body',
    ).toEqual([])
  })

  test('the org-context helper used by knowledge-graph tests is called from bodies', () => {
    const src = readRepo('src/lib/knowledge-graph.test.ts')
    // The guard is only meaningful if the helper actually exists and the tests use it.
    expect(src).toContain('function withOrg')
    // Every test body must route through it; counting is enough to catch a rewrite that
    // drops the wrapper from a single test.
    const tests = [...src.matchAll(/\n\s*test\(/g)].length
    const wrapped = [...src.matchAll(/return withOrg\(async \(\) => \{/g)].length
    expect(wrapped).toBe(tests)
  })
})
