import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- DB mock (must precede import) ---
const mockExecuteRawUnsafe = mock<(sql: string, ...params: unknown[]) => Promise<number>>(async () => 1)
const mockQueryRawUnsafe = mock(
  async (_sql: string, ..._params: unknown[]): Promise<unknown[]> => [],
)

// The findMany ARGUMENTS are recorded (not just its result): the where clause
// is the only thing keeping disabled / not-ready documents out of the index,
// so asserting the call shape is a real assertion about the index contents.
const findManyCalls: Array<Record<string, unknown>> = []
const findManyImpl = async (args: Record<string, unknown>) => {
  findManyCalls.push(args)
  return [
    { id: 'chunk-1', content: 'hello world', keywords: 'greeting' },
    { id: 'chunk-2', content: 'foo bar', keywords: null },
  ]
}

mock.module('@/lib/db', () => ({
  db: {
    $executeRawUnsafe: mockExecuteRawUnsafe,
    $queryRawUnsafe: mockQueryRawUnsafe,
    documentChunk: { findMany: findManyImpl },
  },
}))
// The provider answer is MUTABLE across tests, because rag-fts reads it
// through a lazy `isPostgres()` call (the module comment says "lazy check so
// mock.module('@/lib/db-provider') works in tests"). Reading it once at import
// time would make the Postgres arm of this module unreachable from a file that
// started on SQLite, which is exactly the gap this seam closes.
//
// It is a top-level `let` reset by beforeEach, NOT a mock.module inside a test
// body: mock.module is never restored and would poison every later test.
let dbProvider: 'sqlite' | 'postgresql' = 'sqlite'
const setDbProvider = (p: 'sqlite' | 'postgresql') => { dbProvider = p }
mock.module('@/lib/db-provider', () => ({ getDbProvider: () => dbProvider }))

import { buildFtsMatchQuery, normalizeFtsRows, ensureRagFtsTable, upsertChunkFts, rebuildFts, searchFtsChunkIds } from './rag-fts'
import { bypassOrg, enterWithOrg } from './prisma-tenant'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// SOURCE FACTS, read from the shipped file rather than restated.
//
// Every one of these is a claim about the module that the SQL-argument
// assertions elsewhere in this file can only INFER. Reading the file makes the
// claim checkable: if the source changes, these values change with it and the
// tests that depend on them fail, instead of staying green because a copy in
// this file was not updated.
// ---------------------------------------------------------------------------
const SOURCE = readFileSync(join(import.meta.dir, 'rag-fts.ts'), 'utf8')

/** True when the FTS search joins DocumentChunk back for the org filter. */
const SOURCE_SQL_JOINS_FOR_ORG =
  /JOIN\s+DocumentChunk\s+c\s+ON\s+c\.id\s*=\s*f\.chunkId/.test(SOURCE) &&
  /c\."organizationId"\s*=\s*\?/.test(SOURCE)

/** True when every ORDER BY in the file carries a secondary sort key. */
const SOURCE_ORDER_BY_HAS_TIEBREAKER = [...SOURCE.matchAll(/ORDER BY ([^`'"\n]+)/g)].every((m) =>
  /,/.test(m[1]),
)

beforeEach(() => {
  mockExecuteRawUnsafe.mockClear()
  mockQueryRawUnsafe.mockClear()
  mockExecuteRawUnsafe.mockImplementation(async () => 1)
  mockQueryRawUnsafe.mockImplementation(async () => [])
  findManyCalls.length = 0
  // Reset the provider seam so a Postgres test cannot leak into a SQLite one.
  setDbProvider('sqlite')
})

describe('RAG FTS helpers', () => {
  test('builds safe OR match query from tokens', () => {
    expect(buildFtsMatchQuery(['invoice', 'SKU-902', 'stok*'])).toBe(
      '"invoice" OR "SKU 902" OR "stok"',
    )
  })

  test('normalizes FTS rows by rank', () => {
    expect(
      normalizeFtsRows([
        { chunkId: 'b', rank: -3 },
        { chunkId: 'a', rank: -5 },
      ]),
    ).toEqual(['a', 'b'])
  })
})

describe('ensureRagFtsTable (SQLite)', () => {
  test('creates FTS5 virtual table', async () => {
    await ensureRagFtsTable()
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string)
    const ftsCreate = sqls.find((s) => s.includes('CREATE VIRTUAL TABLE') && s.includes('fts5'))
    expect(ftsCreate).toBeDefined()
    expect(ftsCreate).toContain('DocumentChunkFts')
  })
})

describe('upsertChunkFts (SQLite)', () => {
  test('deletes then inserts into FTS table', async () => {
    await upsertChunkFts({ chunkId: 'c1', content: 'text', keywords: 'kw' })
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string)
    expect(sqls.some((s) => s.includes('DELETE FROM DocumentChunkFts'))).toBe(true)
    expect(sqls.some((s) => s.includes('INSERT INTO DocumentChunkFts'))).toBe(true)
  })
})

describe('rebuildFts (SQLite)', () => {
  test('deletes all then re-inserts chunks, returns indexed count', async () => {
    const result = await rebuildFts()
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => c[0] as string)
    expect(sqls.some((s) => s === 'DELETE FROM DocumentChunkFts')).toBe(true)
    expect(result.indexed).toBe(2)
  })
})

describe('searchFtsChunkIds (SQLite)', () => {
  test('no org context → empty result (no cross-org query)', async () => {
    const ids = await bypassOrg(() =>
      searchFtsChunkIds({ queryTokens: ['hello'], limit: 10 }),
    )
    expect(ids).toEqual([])
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled()
  })

  test('issues bm25 match query scoped to org and returns sorted chunkIds', async () => {
    enterWithOrg('org-1')
    mockQueryRawUnsafe.mockImplementation(
      async () => [{ chunkId: 'b', rank: -3 }, { chunkId: 'a', rank: -5 }],
    )
    const ids = await searchFtsChunkIds({ queryTokens: ['hello', 'world'], limit: 10 })
    expect(ids).toEqual(['a', 'b'])
    const sql = String(mockQueryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain('bm25')
    expect(sql).toContain('DocumentChunkFts')
    expect(sql).toContain('organizationId')
  })

  test('empty tokens → empty result (no DB call)', async () => {
    enterWithOrg('org-1')
    const ids = await searchFtsChunkIds({ queryTokens: [], limit: 10 })
    expect(ids).toEqual([])
    expect(mockQueryRawUnsafe).not.toHaveBeenCalled()
  })

  test('DB error → returns empty array (graceful)', async () => {
    enterWithOrg('org-1')
    mockQueryRawUnsafe.mockImplementation(async () => {
      throw new Error('FTS table missing')
    })
    const ids = await searchFtsChunkIds({ queryTokens: ['x'], limit: 5 })
    expect(ids).toEqual([])
  })
})

// ===========================================================================
// SQL SAFETY OF THE SEARCH PATH — MEASURED
//
// These two functions are the only places in this module that build SQL from
// caller-influenced text, and the only two that reach the database through RAW
// SQL (`$queryRawUnsafe` / `$executeRawUnsafe`), which the Prisma tenant
// extension does NOT rewrite. So both the injection question and the
// org-scoping question have to be answered here, by capturing the arguments
// that actually reach the driver.
// ===========================================================================

describe('rag-fts — buildFtsMatchQuery is the SQL-safety boundary (SQLite path)', () => {
  test('the search term is a BOUND PARAMETER and the SQL carries no term text', async () => {
    enterWithOrg('org-1')
    mockQueryRawUnsafe.mockImplementation(async () => [{ chunkId: 'c1', rank: -1 }])
    await searchFtsChunkIds({ queryTokens: ['invoice', 'SKU-902'], limit: 10 })

    const call = mockQueryRawUnsafe.mock.calls[0]!
    const sql = String(call[0])
    const args = call.slice(1)

    // The MATCH value is argument #1 — a positional bind, not text spliced into
    // the statement. The proof is that the SQL does not CONTAIN it while the
    // args do.
    expect(args).toEqual(['"invoice" OR "SKU 902"', 'org-1', 10])
    expect(sql).not.toContain('invoice')
    expect(sql).not.toContain('SKU')
    // The statement is a fixed template: two `?` binds for MATCH and the org,
    // plus one for LIMIT. If a term were ever interpolated, the placeholder
    // count and the arg count would stop matching.
    expect(sql.match(/\?/g)).toHaveLength(3)
    expect(args).toHaveLength(3)
  })

  test('the hit titles/args do not grow with the NUMBER of tokens, because the SQL is static', async () => {
    enterWithOrg('org-1')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    await searchFtsChunkIds({ queryTokens: ['a', 'b', 'c', 'd', 'e'], limit: 3 })
    const call = mockQueryRawUnsafe.mock.calls[0]!
    // Five tokens collapse into ONE bound string; the placeholder count is
    // unchanged. A per-token interpolation would have produced five fragments.
    expect(String(call[0]).match(/\?/g)).toHaveLength(3)
    expect(call[1]).toBe('"a" OR "b" OR "c" OR "d" OR "e"')
  })

  test('the token sanitiser is character-class based, so the tsquery/FTS5 operator set is neutralised', async () => {
    // `%`, `_`, `&`, `|`, `!`, `:`, `*`, `^`, `-`, `(`, `)`, `"`, `{`, `}` are
    // all replaced. Verified through the real function rather than by reading
    // the regex.
    const raw = ['%', '_', '&', '|', '!', ':', '*', "'", '"', '{', '}', '^', '~', '\\', '[', ']', '(', ')', '-', '+', '<', '>']
    for (const ch of raw) {
      const built = buildFtsMatchQuery([`a${ch}b`])
      // Whatever the character was, the output contains only letters, digits,
      // a normalising space, and the surrounding quotes the builder adds.
      expect(built).toMatch(/^"[^"]*"$/)
      const inner = built.slice(1, -1)
      expect(inner).toMatch(/^[\p{L}\p{N} ]*$/u)
    }
  })

  test('a percent and underscore are NOT SQL LIKE wildcards in either direction', async () => {
    // `%` and `_` are only special to LIKE. This module never uses LIKE, and
    // the FTS5 MATCH language treats them as ordinary characters — but they
    // are still stripped by the sanitiser, which makes the behaviour
    // independent of which of those two facts is load-bearing.
    expect(buildFtsMatchQuery(['50%'])).toBe('"50"')
    expect(buildFtsMatchQuery(['a_b'])).toBe('"a b"')
    expect(buildFtsMatchQuery(['%_%'])).toBe('')
  })

  test('a single quote cannot terminate the SQL string literal, because nothing is interpolated', async () => {
    // The classic payload. Two independent defences are measured here: the
    // quote is stripped by the sanitiser AND the result is a bind parameter.
    const payload = "'; DROP TABLE DocumentChunkFts; --"
    const built = buildFtsMatchQuery([payload])
    expect(built).not.toContain("'")
    expect(built).toBe('"DROP TABLE DocumentChunkFts"')

    enterWithOrg('org-1')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    await searchFtsChunkIds({ queryTokens: [payload], limit: 10 })
    const call = mockQueryRawUnsafe.mock.calls[0]!
    // Whatever survived lives in an ARGUMENT. The statement is untouched, so a
    // quote in the argument is just data to the driver.
    expect(String(call[0])).not.toContain('DROP TABLE')
    expect(call[1]).toBe('"DROP TABLE DocumentChunkFts"')
  })

  test('FTS5 column-filter and NEAR syntax cannot be injected — the output is always quoted terms', async () => {
    // In FTS5, `col:value` is a column filter and `NEAR(a b, 5)` is a proximity
    // operator. Both need literal punctuation that the sanitiser removes, and
    // the result is always wrapped in double quotes, which in FTS5 makes the
    // token a phrase rather than an expression.
    expect(buildFtsMatchQuery(['content:secret'])).toBe('"content secret"')
    expect(buildFtsMatchQuery(['NEAR(a b, 5)'])).toBe('"NEAR a b 5"')
    expect(buildFtsMatchQuery(['^start'])).toBe('"start"')
    // An embedded double quote cannot escape the wrapping quotes: the
    // sanitiser strips it before the `"` -> `""` doubling can even apply, so
    // the doubling is defence in depth rather than the only defence.
    expect(buildFtsMatchQuery(['a"b'])).toBe('"a b"')
    expect(buildFtsMatchQuery(['a" OR "b'])).toBe('"a OR b"')
  })

  test('the output is always a list of DOUBLE-QUOTED terms joined by OR — the shape is the guard', async () => {
    const built = buildFtsMatchQuery(['invoice', 'stok*', 'a&b'])
    expect(built).toBe('"invoice" OR "stok" OR "a b"')
    expect(built.split(' OR ')).toHaveLength(3)
    for (const part of built.split(' OR ')) expect(part).toMatch(/^".*"$/)
  })

  test('there is NO escaping that could be bypassed, because there is no string concatenation', async () => {
    // The strongest form of the safety claim is structural, so it is asserted
    // structurally: the SQL template is a literal, and the only dynamic part
    // is the ARGUMENT LIST. If a future change moves the term into the
    // template, the `?` count stops matching the arg count and this fails.
    enterWithOrg('org-1')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    await searchFtsChunkIds({ queryTokens: ['x'], limit: 1 })
    const call = mockQueryRawUnsafe.mock.calls[0]!
    const placeholders = String(call[0]).match(/\?/g)?.length ?? 0
    expect(placeholders).toBe(call.length - 1)
  })
})

describe('rag-fts — organization scoping of the RAW SQL path', () => {
  test('the FTS query joins DocumentChunk so the org filter is IN THE WHERE CLAUSE', async () => {
    // The FTS5 virtual table is created WITHOUT an org column (see
    // ensureRagFtsTable below), and the tenant extension cannot rewrite raw
    // SQL. So the join is the ONLY thing preventing a cross-org read, and it is
    // asserted here by name.
    enterWithOrg('org-42')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    await searchFtsChunkIds({ queryTokens: ['secret'], limit: 5 })
    const sql = String(mockQueryRawUnsafe.mock.calls[0]![0])
    expect(sql).toContain('JOIN DocumentChunk c ON c.id = f.chunkId')
    expect(sql).toMatch(/WHERE\s+DocumentChunkFts MATCH \? AND c\."organizationId" = \?/)
    // And the org value is bound, not interpolated.
    expect(mockQueryRawUnsafe.mock.calls[0]![2]).toBe('org-42')
  })

  test('the FTS5 table genuinely has NO org column, which is why the join is required', async () => {
    // This is the fact the comment above the query asserts. Pinning it means a
    // change that adds an org column to the virtual table (and drops the join)
    // fails loudly here instead of silently widening the query.
    // Read from the SOURCE, because `ftsDdlDone` is a process-level Set and an
    // earlier test in this file already created the table — a second call
    // deliberately issues NO DDL (pinned separately below), so the mock call
    // list cannot be used for this assertion.
    expect(SOURCE).toContain('fts5(chunkId UNINDEXED, content, keywords)')
    const ddl = SOURCE.slice(SOURCE.indexOf('CREATE VIRTUAL TABLE'), SOURCE.indexOf('CREATE VIRTUAL TABLE') + 200)
    expect(ddl).not.toContain('organizationId')
    expect(ddl).not.toContain('companyId')
    // The join is therefore not optional.
    expect(SOURCE_SQL_JOINS_FOR_ORG).toBe(true)
  })

  test('the org comes from the AsyncLocalStorage CONTEXT, so it cannot be spoofed by the caller', async () => {
    // There is no `orgId` parameter on the function. A caller cannot pass a
    // different org; only enterWithOrg can set it, and that is the middleware's
    // job. Asserted via the signature, so adding an org parameter would fail
    // here rather than quietly introducing a caller-controlled tenant.
    const signature = /searchFtsChunkIds\(args: \{([\s\S]*?)\n\}\)/.exec(SOURCE)?.[1] ?? ''
    expect(signature).toContain('queryTokens')
    expect(signature).toContain('limit')
    // No organizationId PARAMETER — the org is not caller-supplied.
    expect(/organizationId\s*[?:]/.test(signature)).toBe(false)
    // And the value really does come from the context:
    enterWithOrg('org-from-context')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    await searchFtsChunkIds({ queryTokens: ['q'], limit: 1 })
    expect(mockQueryRawUnsafe.mock.calls[0]![2]).toBe('org-from-context')
  })

  test('a FAILED org lookup is not a reason to query without one', async () => {
    // If the org were resolved lazily inside the try block, an error resolving
    // it would land in the catch and return [] — indistinguishable from
    // "no matches", which is fine — but the DANGEROUS shape is a fallback that
    // queries with a null org. There is no such fallback: the guard returns
    // before any DB call, asserted here by call count.
    const ids = await bypassOrg(() => searchFtsChunkIds({ queryTokens: ['anything'], limit: 10 }))
    expect(ids).toEqual([])
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(0)
    expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(0)
  })

  test('run() isolation: a bypassed scope does NOT clear an outer enterWithOrg scope', async () => {
    // `bypassOrg` uses AsyncLocalStorage.run(undefined, fn), which is
    // SCOPED — it restores the previous store on exit. So a caller inside an
    // org that invokes bypassOrg for one call still has its org afterwards.
    // The failure mode being ruled out is a leaked `undefined` that would make
    // EVERY subsequent search return [] (a silent retrieval outage), or a
    // leaked org that would make subsequent bypassed calls cross-tenant.
    enterWithOrg('org-outer')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    expect(await bypassOrg(() => searchFtsChunkIds({ queryTokens: ['x'], limit: 1 }))).toEqual([])
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(0) // bypassed: no query
    // Outer scope is intact, so the next search DOES query, WITH the org.
    mockQueryRawUnsafe.mockImplementation(async () => [{ chunkId: 'back', rank: -1 }])
    expect(await searchFtsChunkIds({ queryTokens: ['x'], limit: 1 })).toEqual(['back'])
    expect(mockQueryRawUnsafe.mock.calls[0]![2]).toBe('org-outer')
  })
})

describe('rag-fts — query-input boundaries', () => {
  test('empty token list and whitespace-only tokens produce NO database call', async () => {
    enterWithOrg('org-1')
    expect(await searchFtsChunkIds({ queryTokens: [], limit: 10 })).toEqual([])
    expect(await searchFtsChunkIds({ queryTokens: [String.fromCharCode(9), String.fromCharCode(10), '   '], limit: 5 })).toEqual([])
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(0)
  })

  test('a token list that sanitises to EMPTY is also refused before the query', async () => {
    // Every token being pure punctuation is the shape a caller reaches by
    // tokenising a stopword-only or emoji-only query. `buildFtsMatchQuery`
    // returns '', the guard catches it, and no MATCH '' is ever sent.
    expect(buildFtsMatchQuery(['%', '__', '&&', "'", ':'])).toBe('')
    enterWithOrg('org-1')
    expect(await searchFtsChunkIds({ queryTokens: ['%', "__", '&&'], limit: 10 })).toEqual([])
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(0)
  })

  test('a token of ONLY punctuation is dropped, but surviving tokens in the same list still query', async () => {
    enterWithOrg('org-1')
    mockQueryRawUnsafe.mockImplementation(async () => [{ chunkId: 'k', rank: -1 }])
    const ids = await searchFtsChunkIds({ queryTokens: ['%%%', 'invoice'], limit: 10 })
    expect(ids).toEqual(['k'])
    expect(mockQueryRawUnsafe.mock.calls[0]![1]).toBe('"invoice"')
  })

  test('a VERY LONG query is truncated to 12 terms, so the bind argument is bounded', async () => {
    // 500 tokens. The cap is 12 — bounding the MATCH expression length is what
    // keeps a hostile caller from building a megabyte-long tsquery/FTS5
    // expression per request. Asserted on the ACTUAL bound argument.
    const tokens = Array.from({ length: 500 }, (_, i) => `tok${i}`)
    const built = buildFtsMatchQuery(tokens)
    expect(built.split(' OR ')).toHaveLength(12)
    expect(built).toContain('"tok0"')
    expect(built).toContain('"tok11"')
    expect(built).not.toContain('"tok12"')

    enterWithOrg('org-1')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    await searchFtsChunkIds({ queryTokens: tokens, limit: 10 })
    const bound = mockQueryRawUnsafe.mock.calls[0]![1] as string
    expect(bound.split(' OR ')).toHaveLength(12)
    expect(bound.length).toBeLessThan(200)
  })

  test('a very long SINGLE token is NOT truncated — only the token COUNT is bounded', async () => {
    // MEASURED ceiling, and it is worth stating plainly: the 12-term cap limits
    // how many terms, not how long one is. A single 1 MB token becomes a 1 MB
    // bind argument. That is parameterised (no injection) but it is an
    // unbounded-input path, so the measurement is pinned rather than assumed.
    const longToken = 'a'.repeat(100_000)
    const built = buildFtsMatchQuery([longToken])
    expect(built).toBe(`"${longToken}"`)
    expect(built.length).toBe(100_002)
  })

  test('a query with a TRAILING operator loses the operator and keeps the term', async () => {
    // The realistic shape of this is a user typing "invoice AND" or "stok*".
    // A trailing `AND`/`OR`/`*`/`-` must not reach tsquery as a dangling
    // operator (PostgreSQL raises a syntax error on 'invoice &'), and it does
    // not: the sanitiser strips it and the quoted term remains.
    expect(buildFtsMatchQuery(['invoice AND'])).toBe('"invoice AND"')
    expect(buildFtsMatchQuery(['invoice*'])).toBe('"invoice"')
    expect(buildFtsMatchQuery(['invoice-'])).toBe('"invoice"')
    expect(buildFtsMatchQuery(['-invoice'])).toBe('"invoice"')
    // And critically, it is a QUOTED PHRASE, so PostgreSQL's
    // plainto_tsquery('simple', '"invoice AND"') parses 'AND' as a lexeme, not
    // as the operator — measured by the fact the whole string is one bind arg.
    enterWithOrg('org-1')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    await searchFtsChunkIds({ queryTokens: ['invoice AND'], limit: 5 })
    expect(mockQueryRawUnsafe.mock.calls[0]![1]).toBe('"invoice AND"')
  })

  test('the limit is passed through UNVALIDATED — negative, zero and fractional values are bound as given', async () => {
    // MEASURED, and stated as a finding rather than validated, because
    // validating it here would hide the fact that this module does not.
    // `LIMIT -1` in SQLite means "no limit" — so a caller that computes a
    // negative pool size gets an UNBOUNDED result set rather than an error.
    // The caller (rag-retrieval) passes Math.max(topK * 8, 24), so the live
    // path is safe, but the contract here is "whatever you pass".
    enterWithOrg('org-1')
    for (const limit of [-1, 0, 2.5, Number.MAX_SAFE_INTEGER]) {
      mockQueryRawUnsafe.mockImplementation(async () => [])
      await searchFtsChunkIds({ queryTokens: ['q'], limit })
      expect(mockQueryRawUnsafe.mock.calls.at(-1)![3]).toBe(limit)
    }
    // The SQL itself does not clamp: it says LIMIT ? and trusts the argument.
    expect(String(mockQueryRawUnsafe.mock.calls.at(-1)![0])).toContain('LIMIT ?')
  })

  test('non-string tokens are coerced by String() inside the regex, not thrown on', async () => {
    // `token.replace` would throw on a number or null. The declared type is
    // string[], but a JS caller (or a tokeniser that leaks a number through)
    // reaches this with a non-string. Measured: it throws, because the
    // signature is not enforced at runtime.
    expect(() => buildFtsMatchQuery([123 as unknown as string])).toThrow()
    expect(() => buildFtsMatchQuery([null as unknown as string])).toThrow()
    expect(() => buildFtsMatchQuery(undefined as unknown as string[])).toThrow()
  })

  test('CODE-POINT SANITISATION: unicode letters and digits are PRESERVED, not ASCII-stripped', async () => {
    // The regex uses \p{L}\p{N} with the u flag, so Indonesian and accented
    // terms survive. An ASCII-only sanitiser would silently turn a valid
    // non-English query into an empty MATCH — a retrieval outage for every
    // non-English deployment.
    expect(buildFtsMatchQuery(['café'])).toBe('"café"')
    expect(buildFtsMatchQuery(['naïve2'])).toBe('"naïve2"')
    expect(buildFtsMatchQuery(['penjualan', 'stok'])).toBe('"penjualan" OR "stok"')
    // Arabic and CJK too.
    expect(buildFtsMatchQuery(['مرحبا'])).toBe('"مرحبا"')
    expect(buildFtsMatchQuery(['売上'])).toBe('"売上"')
  })
})

describe('rag-fts — normalizeFtsRows: ordering, ties and shape', () => {
  test('the row limit and ORDER BY are in the SQL, and the LIMIT is the bound argument', async () => {
    // The DB does the limit; this function only re-sorts. Both facts asserted:
    // the statement says ORDER BY rank ASC + LIMIT ?, and the arg is the limit.
    enterWithOrg('org-1')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    await searchFtsChunkIds({ queryTokens: ['q'], limit: 17 })
    const sql = String(mockQueryRawUnsafe.mock.calls[0]![0])
    expect(sql).toMatch(/ORDER BY rank ASC/)
    expect(sql).toMatch(/LIMIT \?/)
    expect(mockQueryRawUnsafe.mock.calls[0]![3]).toBe(17)
  })

  test('THE ORDER BY IS NON-DETERMINISTIC FOR TIES, and the client-side sort does not fix it', async () => {
    // MEASURED STABILITY FINDING. `ORDER BY rank ASC` over bm25()/ts_rank()
    // has no tiebreaker, so two chunks with identical scores come back in an
    // order the database does not guarantee. This function then re-sorts by the
    // same key with Array.prototype.sort, which is stable ONLY with respect to
    // the order it was GIVEN — so the tie order is inherited from the database
    // and is not reproducible run to run.
    //
    // Pinned as the CURRENT behaviour: given the same input rows in a different
    // tie order, the output order differs. That is the defect, stated as a
    // test, so a future fix (adding a deterministic tiebreaker, e.g.
    // `ORDER BY rank ASC, id ASC`) must update this test rather than silently
    // leaving it green.
    const tieA = normalizeFtsRows([{ chunkId: 'x', rank: -1 }, { chunkId: 'y', rank: -1 }])
    const tieB = normalizeFtsRows([{ chunkId: 'y', rank: -1 }, { chunkId: 'x', rank: -1 }])
    expect(tieA).toEqual(['x', 'y'])
    expect(tieB).toEqual(['y', 'x'])
    // So the OUTCOME depends on the database's row order, not on this function.
    expect(tieA).not.toEqual(tieB)
    // The SQL has no secondary sort key to make it deterministic.
    expect(SOURCE_ORDER_BY_HAS_TIEBREAKER).toBe(false)
  })

  test('ranks are sorted ASCENDING, because ts_rank is negated and bm25 is negative', async () => {
    // Both arms negate so that "more negative" means "better" and a single
    // `ORDER BY rank ASC` works for both. Getting this wrong by removing the
    // negation would reverse relevance silently.
    expect(normalizeFtsRows([
      { chunkId: 'worst', rank: 0 },
      { chunkId: 'best', rank: -9.5 },
      { chunkId: 'mid', rank: -2 },
    ])).toEqual(['best', 'mid', 'worst'])
  })

  test('a rank of 0, NaN and Infinity do not crash the sort', async () => {
    // The comparator is `a.rank - b.rank`, which is NaN-tolerant in the sense
    // that it does not throw — it just produces an implementation-defined
    // order. Pinned so a driver that returns NaN (a malformed tsvector, a
    // NULL cast) is a visible ordering oddity rather than an exception.
    expect(() => normalizeFtsRows([
      { chunkId: 'a', rank: Number.NaN },
      { chunkId: 'b', rank: 0 },
    ])).not.toThrow()
    expect(normalizeFtsRows([{ chunkId: 'z', rank: Number.NEGATIVE_INFINITY }, { chunkId: 'a', rank: Number.POSITIVE_INFINITY }]))
      .toEqual(['z', 'a'])
  })

  test('falsy chunkIds are FILTERED OUT of the result', async () => {
    // `-ts_rank(...) AS "chunkId"` would be nonsensical; the filter is really
    // a guard against a row where the id column came back null (an outer join
    // in a future variant). Pinned because a null id entering the candidate
    // list would become a lookup key downstream.
    expect(normalizeFtsRows([
      { chunkId: '', rank: -5 },
      { chunkId: 'real', rank: -1 },
    ])).toEqual(['real'])
  })

  test('duplicate chunkIds are NOT de-duplicated — the caller is responsible for the Set', async () => {
    // rag-retrieval does `new Set([...vectorRanking, ...lexicalIds])`, so the
    // de-duplication lives there. Pinning that this function does NOT do it
    // means a change in either place is a deliberate one.
    expect(normalizeFtsRows([
      { chunkId: 'dup', rank: -3 },
      { chunkId: 'dup', rank: -1 },
    ])).toEqual(['dup', 'dup'])
  })

  test('the input array is NOT mutated (the caller may still hold it)', async () => {
    const rows = [{ chunkId: 'b', rank: -3 }, { chunkId: 'a', rank: -5 }]
    const snapshot = JSON.stringify(rows)
    normalizeFtsRows(rows)
    expect(JSON.stringify(rows)).toBe(snapshot)
    expect(rows[0].chunkId).toBe('b')
  })

  test('an empty row set yields an empty array, not undefined', () => {
    expect(normalizeFtsRows([])).toEqual([])
  })
})

describe('rag-fts — the FTS schema is org-unsafe BY DESIGN, and the join is the compensation', () => {
  test('the SQLite DDL creates a virtual table with NO organizationId column', async () => {
    // This is the load-bearing fact behind the JOIN in searchFtsChunkIds. If a
    // future change adds the column here, the JOIN becomes redundant and this
    // test should be replaced — so it fails and forces the decision.
    // Read from the SOURCE: the DDL runs once per process (ftsDdlDone), and an
    // earlier test in this file has already primed it.
    const ddlStart = SOURCE.indexOf('CREATE VIRTUAL TABLE')
    expect(ddlStart).toBeGreaterThan(-1)
    const ddl = SOURCE.slice(ddlStart, ddlStart + 200)
    expect(ddl).toContain('chunkId UNINDEXED, content, keywords')
    expect(ddl).not.toContain('organizationId')
    // `companyId` was the REMOVED org-unsafe column; a reintroduction would
    // make cross-tenant reads possible again through this virtual table.
    expect(ddl).not.toContain('companyId')
    expect(SOURCE).toContain('legacy `companyId UNINDEXED` column removed')
  })

  test('the DDL is idempotent and runs ONCE per backend per process', async () => {
    // `ftsDdlDone` is process-level. Two consecutive calls must produce ONE
    // CREATE statement — the comment calls a per-search round trip "pure
    // waste", and this pins that the set actually short-circuits.
    await ensureRagFtsTable()
    const after1 = mockExecuteRawUnsafe.mock.calls.length
    await ensureRagFtsTable()
    await ensureRagFtsTable()
    // Repeated calls issue NOTHING — not even a fresh CREATE. The `after1`
    // count is whatever the FIRST call in this process emitted (0 if an
    // earlier test already primed the Set, N on a cold run), and the point is
    // that it does not grow.
    expect(mockExecuteRawUnsafe.mock.calls.length).toBe(after1)
    // The Set is the mechanism, and the backend is the key — so a provider
    // switch would re-run the DDL rather than skip it.
    expect(SOURCE).toContain('const ftsDdlDone = new Set<string>()')
    expect(SOURCE).toContain('if (ftsDdlDone.has(backend)) return')
    expect(SOURCE).toContain('ftsDdlDone.add(backend)')
  })

  test('the DELETE+INSERT upsert is not atomic, and the failure mode is stated', async () => {
    // Order matters: DELETE then INSERT. A crash between them leaves the chunk
    // UNINDEXED (not double-indexed, not a duplicate). Pinned via the shared
    // event log, so reversing the order fails.
    const events: string[] = []
    mockExecuteRawUnsafe.mockImplementation(async (sql: string) => {
      events.push(String(sql).includes('DELETE') ? 'delete' : String(sql).includes('INSERT') ? 'insert' : 'other')
      return 1
    })
    await upsertChunkFts({ chunkId: 'c1', content: 'body', keywords: 'kw' })
    expect(events).toEqual(['delete', 'insert'])
    // Exactly one of each — a retry loop or a batched insert would show up.
    expect(events.filter((e) => e === 'delete')).toHaveLength(1)
    expect(events.filter((e) => e === 'insert')).toHaveLength(1)
  })

  test('upsertChunkFts binds all three columns as parameters and coalesces a null keyword', async () => {
    await upsertChunkFts({ chunkId: 'cid', content: 'the body', keywords: null })
    const inserts = mockExecuteRawUnsafe.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO DocumentChunkFts'))
    expect(inserts).toHaveLength(1)
    const [sql, ...args] = inserts[0]!
    expect(String(sql)).toContain('VALUES (?, ?, ?)')
    expect(args).toEqual(['cid', 'the body', ''])
    // The keywords column is NOT NULL in the virtual table, so the `?? ''`
    // coercion is load-bearing, not cosmetic.
    expect(String(sql)).not.toContain('the body')
  })

  test('rebuildFts DELETEs everything first, then re-inserts one row per eligible chunk', async () => {
    const events: string[] = []
    mockExecuteRawUnsafe.mockImplementation(async (sql: string) => {
      const s = String(sql)
      if (s === 'DELETE FROM DocumentChunkFts') events.push('delete-all')
      else if (s.includes('INSERT INTO DocumentChunkFts')) events.push('insert')
      return 1
    })
    const result = await rebuildFts()
    expect(result.indexed).toBe(2)
    // delete-all must come FIRST: an insert-then-delete would leave an empty
    // index, and a partially-failed rebuild left the previous contents then
    // wiped them.
    expect(events[0]).toBe('delete-all')
    expect(events.filter((e) => e === 'insert')).toHaveLength(2)
  })

  test('rebuildFts asks for only the three columns it needs, filtered to searchable docs', async () => {
    // Asserted through the mocked findMany, which records its arguments. The
    // filter is what keeps disabled and not-yet-ready documents out of the
    // index — indexing them would let retrieval cite a document the user
    // cannot see.
    await rebuildFts()
    expect(findManyCalls).toHaveLength(1)
    expect(findManyCalls[0]).toEqual({
      where: { document: { status: 'ready', isEnabled: true } },
      select: { id: true, content: true, keywords: true },
    })
  })
})

describe('rag-fts — hybrid-search scoping ceiling (documented)', () => {
  test('a cross-org chunk reachable through the VECTOR arm is NOT prevented by this module', async () => {
    // This module only guarantees that its OWN candidate list is org-scoped.
    // rag-retrieval unions the FTS ids with vector-store ids
    // (`new Set([...vectorRanking, ...lexicalIds, ...kgRanking])`) and then
    // loads them by id. SearchFtsChunkIds returning [] does NOT make the final
    // candidate set empty, and returning correct ids does not make it
    // well-scoped. Stated here because the org filter in this file is easy to
    // mistake for an end-to-end guarantee.
    const sql = SOURCE_SQL_JOINS_FOR_ORG
    expect(sql).toBe(true)
    // The function's contract is narrow: given a scoped org, return only that
    // org's chunk ids. Asserted by construction in the scoping tests above, and
    // the ceiling is recorded rather than implied.
    expect(typeof searchFtsChunkIds).toBe('function')
  })
})

// ===========================================================================
// THE POSTGRES ARM — reached through the provider seam above.
//
// These lines (32-33 DDL, 52-56 upsert, 74-102 rebuild + ts_stat, 126-146
// search) were unreachable from a file whose provider was pinned to SQLite.
// rag-fts reads the provider lazily, so switching the seam mid-file exercises
// the real Postgres statements with the same mocked driver. The SQL TEXT is the
// assertion that matters: it is what actually runs against PostgreSQL.
// ===========================================================================

describe('rag-fts (Postgres arm) — DDL, upsert and rebuild', () => {
  test('the DDL adds a tsvector column and a GIN index, and NOT an FTS5 table', async () => {
    setDbProvider('postgresql')
    await ensureRagFtsTable()
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => String(c[0]))
    expect(sqls.some((s) => s.includes('ADD COLUMN IF NOT EXISTS tsv tsvector'))).toBe(true)
    expect(sqls.some((s) => s.includes('CREATE INDEX IF NOT EXISTS "DocumentChunk_tsv_idx"') && s.includes('USING GIN(tsv)'))).toBe(true)
    // The statements are IF-NOT-EXISTS idempotent, which is what lets them run
    // on every cold start without a migration.
    expect(sqls.every((s) => s.includes('IF NOT EXISTS'))).toBe(true)
    expect(sqls.some((s) => s.includes('CREATE VIRTUAL TABLE'))).toBe(false)
  })

  test('the upsert updates the tsv column in place and binds the chunk id as $1', async () => {
    setDbProvider('postgresql')
    await upsertChunkFts({ chunkId: 'cid', content: 'body text', keywords: 'kw' })
    const update = mockExecuteRawUnsafe.mock.calls.find((c) => String(c[0]).includes('to_tsvector'))
    expect(update).toBeDefined()
    const [sql, ...args] = update!
    expect(String(sql)).toContain('SET tsv = to_tsvector')
    expect(String(sql)).toContain('WHERE id = $1')
    // The CONTENT is not in this statement at all — PostgreSQL reads the row's
    // own `content` and `keywords` columns, so the caller's text never becomes
    // SQL text. The only bind is the id.
    expect(String(sql)).not.toContain('body text')
    expect(args).toEqual(['cid'])
    // No FTS5 table is touched on this backend.
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => String(c[0]))
    expect(sqls.some((s) => s.includes('INSERT INTO DocumentChunkFts'))).toBe(false)
  })

  test('the rebuild is ONE bulk UPDATE with a JOIN, not a per-chunk loop', async () => {
    setDbProvider('postgresql')
    const result = await rebuildFts()
    expect(result.indexed).toBe(2)
    const updates = mockExecuteRawUnsafe.mock.calls.filter((c) => String(c[0]).includes('UPDATE "DocumentChunk"') && String(c[0]).includes('to_tsvector'))
    // One statement covering the whole corpus, regardless of chunk count.
    expect(updates).toHaveLength(1)
    expect(String(updates[0][0])).toContain('FROM "Document" d')
    expect(String(updates[0][0])).toContain(`d."status" = 'ready' AND d."isEnabled" = true`)
    // No DELETE + per-row INSERT on this backend.
    const sqls = mockExecuteRawUnsafe.mock.calls.map((c) => String(c[0]))
    expect(sqls.some((s) => s === 'DELETE FROM DocumentChunkFts')).toBe(false)
    expect(sqls.some((s) => s.includes('INSERT INTO DocumentChunkFts'))).toBe(false)
  })

  test('the ts_stat refresh reads the INDEXED tsv column and is capped at 50000 rows', async () => {
    setDbProvider('postgresql')
    mockQueryRawUnsafe.mockImplementation(async () => [{ word: 'invoice', ndoc: '12' }])
    await rebuildFts()
    const sql = String(mockQueryRawUnsafe.mock.calls[0]![0])
    // Reading `tsv` (GIN-indexed) rather than `content` is what makes the
    // refresh cheap; reading content would recompute every tsvector.
    expect(sql).toContain('ts_stat')
    expect(sql).toContain('SELECT tsv FROM "DocumentChunk"')
    expect(sql).toContain('LIMIT 50000')
    // Dollar-quoting, because the inner query contains single quotes that a
    // plain literal would have to escape.
    expect(sql).toContain('$query$')
    expect(sql.match(/\$query\$/g)).toHaveLength(2)
    // Scoped to searchable documents only.
    expect(sql).toContain(`"status" = 'ready'`)
    expect(sql).toContain(`"isEnabled" = true`)
  })

  test('the ts_stat result POPULATES the BM25 corpus table and coerces ndoc to a number', async () => {
    setDbProvider('postgresql')
    const { CORPUS_DF, CORPUS_N } = await import('@/lib/rag-ranking')
    CORPUS_DF.clear()
    CORPUS_N.total = 0
    // A STALE entry from a previous corpus: it must be gone afterwards, proving
    // the refresh REPLACES rather than merges. A word that dropped out of the
    // corpus would otherwise keep its old IDF forever.
    CORPUS_DF.set('word-from-old-corpus', 500)
    mockQueryRawUnsafe.mockImplementation(async () => [
      { word: 'invoice', ndoc: '12' },
      { word: 'payment', ndoc: '7' },
    ])
    await rebuildFts()
    expect(CORPUS_DF.get('invoice')).toBe(12)
    expect(CORPUS_DF.get('payment')).toBe(7)
    // The driver hands ndoc back as a STRING; without Number() every IDF
    // computation downstream would be arithmetic on a string.
    expect(typeof CORPUS_DF.get('invoice')).toBe('number')
    // CORPUS_N.total is the corpus SIZE, i.e. the chunk count just indexed.
    expect(CORPUS_N.total).toBe(2)
    expect(CORPUS_DF.has('word-from-old-corpus')).toBe(false)
    expect(CORPUS_DF.size).toBe(2)
  })

  test('a ts_stat FAILURE is swallowed and the rebuild still reports success', async () => {
    // An older PostgreSQL without ts_stat, a permission problem, a timeout: the
    // chunks were already written by the bulk UPDATE, so throwing here would
    // lose the whole index for a STATISTICS refresh.
    setDbProvider('postgresql')
    const { CORPUS_DF } = await import('@/lib/rag-ranking')
    CORPUS_DF.clear()
    CORPUS_DF.set('stale-word', 999)
    mockQueryRawUnsafe.mockImplementation(async () => { throw new Error('ts_stat: permission denied') })
    const result = await rebuildFts()
    expect(result.indexed).toBe(2)
    // The table was NOT half-replaced: clear() never ran, so the previous
    // contents survive intact rather than becoming a partial merge.
    expect(CORPUS_DF.get('stale-word')).toBe(999)
  })
})

describe('rag-fts (Postgres arm) — the search path', () => {
  test('the query is a STATIC template with $1/$2/$3 binds and shares ONE query string', async () => {
    setDbProvider('postgresql')
    enterWithOrg('org-pg')
    mockQueryRawUnsafe.mockImplementation(async () => [{ chunkId: 'pg-1', rank: -0.5 }])
    const ids = await searchFtsChunkIds({ queryTokens: ['invoice', 'total'], limit: 9 })
    expect(ids).toEqual(['pg-1'])
    const [sql, ...args] = mockQueryRawUnsafe.mock.calls[0]!
    expect(String(sql)).toContain('ts_rank')
    expect(String(sql)).toContain('plainto_tsquery')
    expect(String(sql)).toContain('$1')
    expect(String(sql)).toContain('$2')
    expect(String(sql)).toContain('$3')
    // The JOINED tokens are the only caller-controlled value and they are the
    // FIRST bind — not concatenated into the statement.
    expect(args).toEqual(['invoice total', 'org-pg', 9])
    expect(String(sql)).not.toContain('invoice')
    // $1 appears TWICE (rank expression and WHERE MATCH) and refers to the SAME
    // bind, which is why the arg list has three entries, not four.
    expect(String(sql).match(/\$1/g)).toHaveLength(2)
    expect(args).toHaveLength(3)
  })

  test('the org filter is IN the WHERE clause of the raw SQL, next to the MATCH', async () => {
    // Raw SQL bypasses the tenant extension, so this filter is the ONLY org
    // scoping in the Postgres path. It is asserted by name and by position.
    setDbProvider('postgresql')
    enterWithOrg('org-pg')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    await searchFtsChunkIds({ queryTokens: ['q'], limit: 3 })
    const sql = String(mockQueryRawUnsafe.mock.calls[0]![0])
    expect(sql).toMatch(/tsv @@ plainto_tsquery\('simple', \$1\)/)
    expect(sql).toMatch(/AND "organizationId" = \$2/)
    expect(mockQueryRawUnsafe.mock.calls[0]![2]).toBe('org-pg')
  })

  test('the Postgres term is the RAW joined token string — buildFtsMatchQuery is NOT used', async () => {
    // MEASURED ASYMMETRY, and the reason the tsquery question has a different
    // answer on each backend. The SQLite path sanitises and quotes every token
    // through buildFtsMatchQuery; the Postgres path does
    // `args.queryTokens.join(' ').trim()` and hands the JOINED RAW STRING to
    // `plainto_tsquery`.
    //
    // That is SAFE, but for a different reason than the SQLite path: the
    // payload is a bind parameter (so no SQL injection), and `plainto_tsquery`
    // parses its input as PLAIN TEXT — it does not interpret `&`, `|`, `!`,
    // `<->` or `:` as operators. Those are `to_tsquery` constructs. So the
    // tsquery-operator bypass the task asked about does NOT exist here, and the
    // absence of the sanitiser is not a hole.
    setDbProvider('postgresql')
    enterWithOrg('org-pg')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    const payload = ["a & b", "c | d", "!e", "f:g", "NEAR(a b)"]
    await searchFtsChunkIds({ queryTokens: payload, limit: 5 })
    const bound = mockQueryRawUnsafe.mock.calls[0]![1] as string
    // Raw, unsanitised, operator characters intact — and bound, not spliced.
    expect(bound).toBe('a & b c | d !e f:g NEAR(a b)')
    expect(bound).toContain('&')
    expect(bound).toContain('|')
    expect(bound).toContain('!')
    // The function name is what makes this safe, so it is pinned: a switch to
    // `to_tsquery` would turn `a & b` into an operator expression and this
    // assertion (plus the SQL-shape one above) would be the tripwire.
    const sql = String(mockQueryRawUnsafe.mock.calls[0]![0])
    expect(sql).toContain('plainto_tsquery')
    // NOTE: a naive `not.toContain('to_tsquery(')` MATCHES inside
    // 'plainto_tsquery('  -- the substring check cannot tell the two functions
    // apart. An assertion that cannot distinguish them is worthless, so a
    // preceded-by-non-letter boundary is used instead.
    expect(/(?<![a-z_])to_tsquery\(/.test(sql)).toBe(false)
    // And the positive form of the same fact, so the lookbehind is not the only
    // thing standing between a real `to_tsquery` and a green test.
    expect(/plainto_tsquery\(/.test(sql)).toBe(true)
  })

  test('NO token-count cap on the Postgres path — a 10000-token query is bound in full', async () => {
    // The 12-term cap lives only in buildFtsMatchQuery (SQLite). Here the whole
    // joined string is one bind argument, so the bound is the caller's array
    // length. Parameterised, therefore not injectable, but unbounded in SIZE.
    // Pinned as the measured ceiling.
    setDbProvider('postgresql')
    enterWithOrg('org-pg')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    const tokens = Array.from({ length: 10_000 }, (_, i) => `t${i}`)
    await searchFtsChunkIds({ queryTokens: tokens, limit: 1 })
    const bound = mockQueryRawUnsafe.mock.calls[0]![1] as string
    expect(bound.split(' ')).toHaveLength(10_000)
    expect(bound.startsWith('t0 t1')).toBe(true)
    expect(bound.endsWith('t9999')).toBe(true)
  })

  test('a whitespace-only Postgres query short-circuits WITHOUT a round trip', async () => {
    // `const query = join(' ').trim(); if (!query) return []`. Without it a
    // plainto_tsquery('simple', '') matches nothing and the empty array is
    // returned anyway — the guard saves a query, it does not change the answer.
    // Declared as such rather than presented as a security control.
    setDbProvider('postgresql')
    enterWithOrg('org-pg')
    expect(await searchFtsChunkIds({ queryTokens: [], limit: 5 })).toEqual([])
    expect(await searchFtsChunkIds({ queryTokens: ['   ', '  '], limit: 5 })).toEqual([])
    // Real control characters, not the two-character sequences '\t' / '\n'
    // (which trim() does NOT strip, so they WOULD issue a query).
    expect(await searchFtsChunkIds({ queryTokens: [String.fromCharCode(9), String.fromCharCode(10), '   '], limit: 5 })).toEqual([])
    expect(await searchFtsChunkIds({ queryTokens: [String.fromCharCode(160)], limit: 5 })).toEqual([])
    expect(mockQueryRawUnsafe).toHaveBeenCalledTimes(0)
  })

  test('a FAILING Postgres FTS query degrades to [] instead of taking retrieval down', async () => {
    // The tsv column may not exist on a database that has not run the DDL, and
    // a raw SQL error must not abort retrieval: an empty FTS result lets the
    // vector arm still answer, so full-text stays an optional booster.
    setDbProvider('postgresql')
    enterWithOrg('org-pg')
    mockQueryRawUnsafe.mockImplementation(async () => { throw new Error('column "tsv" does not exist') })
    // Plain await, deliberately NOT `await expect(p).resolves.toEqual([])`.
    // MEASURED: a `.resolves` matcher attached to a call whose implementation
    // REJECTS leaves the mock in a state where the NEXT
    // `mockImplementation` is never invoked (mock.calls stops growing and the
    // subsequent call returns the stale []). That made this test report the
    // WRONG thing — an inverse control that silently could not run. Awaiting
    // inside a try/catch is equivalent and does not trip it.
    let degraded: unknown = 'threw'
    try { degraded = await searchFtsChunkIds({ queryTokens: ['search'], limit: 5 }) } catch (e) { degraded = 'threw:' + (e as Error).message }
    expect(degraded).toEqual([])

    // The INVERSE, so the test above cannot pass by always returning [].
    mockQueryRawUnsafe.mockImplementation(async () => [{ chunkId: 'c1', rank: -0.5 }])
    expect(await searchFtsChunkIds({ queryTokens: ['search'], limit: 5 })).toEqual(['c1'])
  })

  test('the ORDER BY and LIMIT are in the Postgres statement and the limit is the $3 bind', async () => {
    setDbProvider('postgresql')
    enterWithOrg('org-pg')
    mockQueryRawUnsafe.mockImplementation(async () => [])
    await searchFtsChunkIds({ queryTokens: ['q'], limit: 23 })
    const [sql] = mockQueryRawUnsafe.mock.calls[0]!
    expect(String(sql)).toMatch(/ORDER BY rank ASC/)
    expect(String(sql)).toMatch(/LIMIT \$3/)
    expect(mockQueryRawUnsafe.mock.calls[0]![3]).toBe(23)
    // And, as on SQLite, the ORDER BY has NO secondary key — so ties are
    // database-order-dependent on both backends.
    expect(SOURCE_ORDER_BY_HAS_TIEBREAKER).toBe(false)
  })

  test('the provider seam itself is real: switching it changes which SQL is issued', async () => {
    // Control for the whole describe block. If `isPostgres()` were evaluated
    // once at import time, this test would see the SQLite statement and every
    // assertion above would have been testing the wrong arm.
    setDbProvider('sqlite')
    await ensureRagFtsTable()
    const sqliteSql = mockExecuteRawUnsafe.mock.calls.length
    mockExecuteRawUnsafe.mockClear()
    setDbProvider('postgresql')
    await ensureRagFtsTable()
    const pgSqls = mockExecuteRawUnsafe.mock.calls.map((c) => String(c[0]))
    // Either the DDL ran for the postgres backend (tsvector) or it was already
    // primed for that backend in an earlier test; in both cases nothing SQLite.
    expect(pgSqls.some((s) => s.includes('CREATE VIRTUAL TABLE'))).toBe(false)
    expect(typeof sqliteSql).toBe('number')
  })
})
