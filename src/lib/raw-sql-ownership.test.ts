/**
 * Raw SQL ownership: every raw statement that reads or writes an org-scoped table binds `organizationId` itself.
 *
 * WHY A STRUCTURAL SWEEP. The tenant extension (`prisma-tenant.ts`) scopes Prisma model calls; it cannot see inside
 * `$queryRaw` / `$executeRaw`, so each raw statement carries its own ownership predicate or it has none. The
 * 2026-10-04 audit listed "raw SQL ownership" as an open boundary, and the sweep that answered it found one write
 * that filtered by chunk id only (the embedding UPDATE in `embeddings.ts`). A per-site test protects the sites
 * someone remembered; this enumerates ALL of them, so a new raw statement without the predicate fails by name.
 *
 * What is checked: every raw call in `src/` and `mini-services/` (tests excluded). A statement whose SQL text is
 * visible in the call is classified — DDL and catalog probes are exempt, anything else touching an org-scoped table
 * must mention `organizationId`. A statement passed as a VARIABLE cannot be read here, so it must appear in
 * `OPAQUE_ALLOWED` with the reason it is safe; an unlisted opaque call fails.
 */
import { describe, expect, test } from 'bun:test'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORG_SCOPED_MODELS } from '@/lib/prisma-tenant'

const ROOT = join(import.meta.dir, '../..')

/** Table names as they appear in SQL: Prisma maps model `documentChunk` to table `"DocumentChunk"`. */
const ORG_TABLES = [...ORG_SCOPED_MODELS].map((m) => m[0].toUpperCase() + m.slice(1))

/**
 * Raw calls whose SQL is built in a variable. Each entry is `file → identifier`, with why it is safe. Keep it short:
 * a new entry is a statement nobody can review from this file.
 */
const OPAQUE_ALLOWED: Record<string, { ident: string; why: string }[]> = {
  'src/lib/connectors.ts': [
    { ident: 'stmt', why: 'demo-schema DDL/INSERT for the bundled demo_* tables, which are not org-scoped models' },
  ],
  'src/lib/rag-vector.ts': [
    { ident: 'setLocal', why: 'SET LOCAL hnsw.* session tuning inside the scoped similarity transaction; no table' },
  ],
}

interface RawCall { file: string; line: number; sql: string | null; ident: string | null }

/** Read a template literal or quoted string starting at `i` (the opening quote). Returns the body. */
function readLiteral(src: string, i: number): string {
  const quote = src[i]
  let j = i + 1
  let depth = 0
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') { j += 2; continue }
    if (quote === '`' && c === '$' && src[j + 1] === '{') { depth++; j += 2; continue }
    if (quote === '`' && depth > 0 && c === '}') { depth--; j++; continue }
    if (c === quote && depth === 0) break
    j++
  }
  return src.slice(i + 1, j)
}

function rawCalls(): RawCall[] {
  const files = [
    ...globSync('src/**/*.ts', { cwd: ROOT }),
    ...globSync('mini-services/**/*.ts', { cwd: ROOT }),
  ].filter((f) => !f.endsWith('.test.ts') && !f.includes('node_modules'))
  const out: RawCall[] = []
  for (const file of files) {
    const src = readFileSync(join(ROOT, file), 'utf8')
    for (const m of src.matchAll(/\$(?:queryRaw|executeRaw)(Unsafe)?\b/g)) {
      const at = m.index! + m[0].length
      const line = src.slice(0, m.index).split('\n').length
      // Skip type positions and mentions in comments/strings such as "`$executeRawUnsafe` runs ONE statement".
      const lineText = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index))
      if (/^\s*(\/\/|\*)/.test(lineText)) continue
      let k = at
      // Optional generic: $queryRaw<Array<...>>
      if (src[k] === '<') {
        let depth = 0
        for (; k < src.length; k++) {
          if (src[k] === '<') depth++
          else if (src[k] === '>' && --depth === 0) { k++; break }
        }
      }
      while (/\s/.test(src[k])) k++
      if (src[k] === '`') { out.push({ file, line, sql: readLiteral(src, k), ident: null }); continue }
      if (src[k] !== '(') continue // a reference such as `db.$queryRaw` passed around, not a call
      k++
      while (/\s/.test(src[k])) k++
      if (src[k] === '`' || src[k] === "'" || src[k] === '"') out.push({ file, line, sql: readLiteral(src, k), ident: null })
      else out.push({ file, line, sql: null, ident: (src.slice(k).match(/^[\w.]+/) ?? [''])[0] })
    }
  }
  return out
}

const EXEMPT = /^\s*(CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+EXTENSION|CREATE\s+(VIRTUAL\s+)?TABLE|ALTER\s+TABLE|DROP\s+INDEX|SET\s+LOCAL|SELECT\s+current_setting|SELECT\s+1\b|SELECT\s+version\(\))/i
const CATALOG = /\b(pg_attribute|pg_class|pg_indexes|pg_extension|information_schema|sqlite_master)\b/i

function touchedOrgTables(sql: string): string[] {
  return ORG_TABLES.filter((t) => new RegExp(`(?<![\\w"])"?${t}"?(?![\\w"])`).test(sql))
}

describe('raw SQL ownership', () => {
  const calls = rawCalls()

  test('the sweep sees the raw statements it is meant to cover (not vacuous)', () => {
    // Counted so a parser regression that finds nothing cannot pass every assertion below.
    const scoped = calls.filter((c) => c.sql && touchedOrgTables(c.sql).length > 0 && !EXEMPT.test(c.sql))
    expect(calls.length).toBeGreaterThanOrEqual(25)
    expect(scoped.length).toBeGreaterThanOrEqual(10)
  })

  test('every visible statement on an org-scoped table binds organizationId', () => {
    const misses = calls
      .filter((c) => c.sql !== null && !EXEMPT.test(c.sql!) && !CATALOG.test(c.sql!))
      .filter((c) => touchedOrgTables(c.sql!).length > 0)
      .filter((c) => !/"?organizationId"?/.test(c.sql!))
      .map((c) => `${c.file}:${c.line} ${c.sql!.replace(/\s+/g, ' ').trim().slice(0, 100)}`)
    expect(misses).toEqual([])
  })

  test('every opaque raw statement is listed with its reason', () => {
    const unlisted = calls
      .filter((c) => c.sql === null)
      .filter((c) => !(OPAQUE_ALLOWED[c.file] ?? []).some((a) => a.ident === c.ident))
      .map((c) => `${c.file}:${c.line} ${c.ident}`)
    expect(unlisted).toEqual([])
  })

  test('no nested relation write: a client id is never linked through connect / connectOrCreate', () => {
    // The extension scopes the top-level model of a write, not a relation it links: `connect: { id }` with a
    // client-supplied id would attach another org's row. MEASURED 2026-10-04: zero such writes exist — every foreign
    // key is set as a plain scalar after a scoped findFirst — and this keeps it at zero. A real need for one must
    // first load the target with findFirst (scoped), then connect that row's id.
    const files = globSync('src/**/*.ts', { cwd: ROOT }).filter((f) => !f.endsWith('.test.ts'))
    const hits = files.flatMap((f) =>
      readFileSync(join(ROOT, f), 'utf8').split('\n')
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /\b(connect|connectOrCreate)\s*:\s*[{[]/.test(l) && !/^\s*(\/\/|\*)/.test(l))
        .map(({ i }) => `${f}:${i + 1}`),
    )
    expect(hits).toEqual([])
  })

  test('the opaque list names only calls that still exist', () => {
    const present = new Set(calls.filter((c) => c.sql === null).map((c) => `${c.file}|${c.ident}`))
    const stale = Object.entries(OPAQUE_ALLOWED).flatMap(([file, list]) =>
      list.filter((a) => !present.has(`${file}|${a.ident}`)).map((a) => `${file} ${a.ident}`),
    )
    expect(stale).toEqual([])
  })
})
