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
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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

  test('src/instrumentation.ts exists and calls startJobWorker()', () => {
    const src = readRepo('src/instrumentation.ts')
    expect(src).toContain('startJobWorker')
  })
})

// ---------------------------------------------------------------------------
// 2. cognee searchType values must exist in the INSTALLED SDK
// ---------------------------------------------------------------------------
// INCIDENT (2026-08): `GRAPH_ENTITIES` / `GRAPH_RELATIONSHIPS` were copied from
// Python cognee docs. The Rust SDK (@cognee/cognee-ts) rejects them with
// `validation error: unknown SearchType '…'` — two of four recall strategies
// failed on every single chat turn. The valid names are re-read from the
// installed SDK's type declaration, so an SDK upgrade that renames a search
// type fails HERE instead of in production logs.
describe('invariant: cognee searchType literals are valid in the installed SDK', () => {
  const SDK_TYPES = 'node_modules/@cognee/cognee-ts/lib/types.d.ts'

  function sdkSearchTypes(): string[] {
    const dts = readRepo(SDK_TYPES)
    const m = /export type SearchTypeString = ([^;]+);/.exec(dts)
    if (!m) throw new Error(`${SDK_TYPES}: SearchTypeString union not found — SDK layout changed, update this guard.`)
    return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1])
  }

  test('the SDK type file still exposes SearchTypeString (guard freshness)', () => {
    const types = sdkSearchTypes()
    expect(types.length).toBeGreaterThanOrEqual(10)
    expect(types).toContain('SUMMARIES')
    expect(types).toContain('CHUNKS')
  })

  test('every searchType literal in cognee-*.ts is in the SDK union', () => {
    const valid = new Set(sdkSearchTypes())
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

  test('COGNEE_SEARCH_TYPES in cognee-types.ts mirrors the SDK union exactly', () => {
    const src = readRepo('src/lib/cognee-types.ts')
    const ours = new Set([...src.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]))
    const sdk = new Set(sdkSearchTypes())
    expect([...ours].filter((t) => !sdk.has(t))).toEqual([])
    expect([...sdk].filter((t) => !ours.has(t))).toEqual([])
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
