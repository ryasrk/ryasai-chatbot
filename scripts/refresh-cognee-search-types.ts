/**
 * Refresh the committed cognee SearchType enum fixture from a RUNNING server.
 *
 * WHY THIS EXISTS. `invariants.test.ts` checks every `searchType` literal in the cognee
 * client against the authoritative list, so an upgrade that renames a type fails in CI
 * instead of failing on a customer's chat turn. That guard used to read the enum out of
 * the installed `@cognee/cognee-ts` type declaration. The bindings were removed on
 * 2026-09-24 when the deployment moved to the cognee v1.6.0 API server, so the authority
 * is now the SERVER's OpenAPI schema — which CI does not run. Hence a committed snapshot
 * plus this refresher: the guard stays automated, and the snapshot is one command away
 * from being current rather than being a hand-maintained list that rots.
 *
 * Usage (against the pinned sidecar, running):
 *   bun scripts/refresh-cognee-search-types.ts [--url=http://127.0.0.1:8099]
 *
 * Then commit the fixture. The diff IS the review: a renamed or dropped search type
 * shows up here before it can reach production.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..')
const FIXTURE = 'src/lib/__fixtures__/cognee-search-types.json'

const urlArg = process.argv.find((a) => a.startsWith('--url='))?.slice('--url='.length)
const baseUrl = (urlArg ?? process.env.COGNEE_SERVER_URL ?? 'http://127.0.0.1:8099').replace(/\/+$/, '')

async function main(): Promise<number> {
  let schema: { paths?: unknown; components?: { schemas?: Record<string, unknown> } }
  try {
    const res = await fetch(`${baseUrl}/openapi.json`, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    schema = (await res.json()) as typeof schema
  } catch (e) {
    console.error(
      `Could not read ${baseUrl}/openapi.json: ${e instanceof Error ? e.message : String(e)}\n` +
        'The refresher needs a RUNNING cognee server (the pinned sidecar). Start it first:\n' +
        '  docker compose up -d cognee   (or docker run cognee/cognee:1.6.0)',
    )
    return 2
  }

  // The enum lives in the OpenAPI schema for the search request. Find it by CONTENT, not by
  // a hardcoded path: the schema moved once already (`/api/v1/search` vs `/search`), and a
  // path-pinned reader would silently find nothing and write an empty list.
  const json = JSON.stringify(schema)
  const match = /"enum":\s*\[([^\]]*"SUMMARIES"[^\]]*)\]/.exec(json)
  if (!match) {
    console.error('No SearchType enum containing SUMMARIES found in the OpenAPI schema. Layout changed — inspect the schema before trusting this script.')
    return 3
  }
  const searchTypes = JSON.parse(`[${match[1]}]`) as string[]
  if (!Array.isArray(searchTypes) || searchTypes.length < 10) {
    console.error(`Refusing to write a suspiciously short enum (${searchTypes?.length ?? 0} entries).`)
    return 4
  }

  const version = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json())
    .then((h: { version?: string }) => h.version ?? 'unknown')
    .catch(() => 'unknown')

  const payload = {
    _comment:
      "Authoritative cognee SearchType enum, read from the server's OpenAPI schema. " +
      'Refresh with scripts/refresh-cognee-search-types.ts against a running server. ' +
      'Committed because CI has no cognee sidecar, and this list is what the searchType invariant checks against.',
    source: `GET ${baseUrl}/openapi.json (cognee ${version})`,
    capturedAt: new Date().toISOString().slice(0, 10),
    searchTypes,
  }
  writeFileSync(join(REPO_ROOT, FIXTURE), `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`Wrote ${FIXTURE} — ${searchTypes.length} search types from cognee ${version}:`)
  console.log(`  ${searchTypes.join(', ')}`)
  return 0
}

process.exit(await main())
