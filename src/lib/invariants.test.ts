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
