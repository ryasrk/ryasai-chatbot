/**
 * 4.3 — Guardrails: SQL Anti-Injection & Mutation Guard
 * ----------------------------------------------------------------------------
 * Adapted from the spec's Python `sqlglot`-based validator. This is a
 * hand-rolled lexical scanner (tokenizer + keyword walk) — deliberately NOT a
 * real SQL parser, so treat it as a fast-reject filter, not a security proof.
 *
 * Enforced rules (mirrors spec §4.3):
 *   1. REJECT all DML/DDL mutation statements: DELETE, UPDATE, INSERT, DROP,
 *      ALTER, TRUNCATE, CREATE, GRANT, REVOKE, MERGE, CALL, EXEC.
 *   2. REJECT multiple statements separated by `;` after the first (injection guard).
 *   3. REJECT dangerous comments / hidden payloads (`--`, `/*`, `xp_`, `sp_`, `;`).
 *   4. REJECT `INTO`, `OUTPUT`, `BULK`, `LOAD_FILE`, `UNION` with system tables.
 *   5. REJECT host-file / outbound-network FUNCTIONS (pg_read_file, dblink,
 *      file(), …) — a keyword scan cannot see these, and they were the hole
 *      that let `SELECT pg_read_file('/etc/passwd')` return host file content.
 *   6. Force a LIMIT 100 safety cap if no LIMIT is present.
 *   7. Whitelist only `SELECT` (with optional WITH/CTE) as the leading keyword.
 *
 * The real security boundary is the DATABASE's own read-only mode, applied in
 * `real-connectors.ts` (`SET TRANSACTION READ ONLY`, ClickHouse `readonly=1`).
 * Rules here must never be the only thing standing between the LLM and data.
 */
import { SQL_MAX_LIMIT } from '@/lib/constants'
import { DANGEROUS_FUNCTIONS } from '@/lib/sql-function-denylist'
import { checkSqlAst, type AstGuardOptions } from '@/lib/sql-ast-guard'
import { inc } from './metrics'

export interface GuardrailResult {
  ok: boolean
  sanitized: string
  reason?: string
  detectedNodes?: string[]
}

const MUTATION_KEYWORDS = new Set([
  'DELETE', 'UPDATE', 'INSERT', 'DROP', 'ALTER', 'TRUNCATE',
  'CREATE', 'GRANT', 'REVOKE', 'MERGE', 'REPLACE', 'CALL',
  'EXEC', 'EXECUTE', 'RENAME', 'ATTACH', 'DETACH', 'PRAGMA',
  // Transaction control — an injected BEGIN/COMMIT must never run here.
  'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'TRANSACTION', 'START',
  // Maintenance DDL / locks — all mutating or side-effecting.
  'VACUUM', 'REINDEX', 'ANALYZE', 'LOCK', 'UNLOCK', 'HANDLER',
])

/** Hard row cap (spec §4.3). Named constant — a safety policy, not env config. */

const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /--/, label: 'inline comment (--)' },
  { re: /\/\*/, label: 'block comment (/*)' },
  { re: /\bxp_\w+/i, label: 'SQL Server extended proc (xp_)' },
  { re: /\bsp_\w+/i, label: 'system stored proc (sp_)' },
  { re: /;\s*\w+/i, label: 'statement chaining (;)' },
  { re: /\bload_file\s*\(/i, label: 'MySQL file read (load_file)' },
  { re: /\binto\s+outfile/i, label: 'MySQL file write (into outfile)' },
  // System / catalog tables (defence-in-depth; the demo connector also enforces
  // a demo_* allowlist). Covers sqlite_master, sqlite_*, information_schema, etc.
  { re: /\b(?:from|join)\s+["`]?(sqlite_master|sqlite_\w*|information_schema|mysql\.|pg_\w+|sys\.|system\.)["`]?/i, label: 'system/catalog table access' },
  // ClickHouse `system.*` was NOT covered and slipped through: `SELECT * FROM
  // system.processes` exposes every running query on the server (including other
  // tenants' SQL and, in some tables, credentials). Found by probing each
  // supported dialect (trial/32) rather than by reading the rule list.
  // NOTE: the guard is still lexical — the real containment is DB-level
  // read-only plus the customer granting a least-privilege login.
  { re: /\bunion\s+select\b.*\bfrom\s+(information_schema|mysql|pg_|sys\.|sqlite_)/i, label: 'system-table union scan' },
  { re: /\battach\s+database\b/i, label: 'SQLite attach database' },
]

/**
 * Side-effecting server functions that a leading-`SELECT` keyword check cannot
 * see. These read/write host files or open outbound connections from the DB
 * server, so they bypass "no mutation keywords" entirely.
 *
 * INCIDENT (2026-09): `SELECT pg_read_file('/etc/passwd')` passed every rule
 * above and returned the database host's `/etc/passwd`. Same for `pg_sleep`,
 * `set_config`, `dblink`, `lo_import`. This list — plus the DB-layer read-only
 * mode in `real-connectors.ts` — closes that class.
 *
 * Scanned against string-masked SQL so a literal such as
 * `WHERE note = 'pg_read_file('` is not a false positive.
 */
/**
 * Injection SHAPES, not vocabulary. The function list above catches specific
 * server functions, and MUTATION_KEYWORDS catches writes — but a tautology such
 * as `WHERE name = or 1=1` is a valid-looking SELECT with no mutation and no
 * dangerous function, so both lists miss it. Found by the 518-case trial/fleet
 * run, where all five classic shapes passed: `union select`, `or 1=1`,
 * `and 1=1`, `or '1'='1'`, plus hex (`0x27`) and function-encoded
 * (`char(39)or`, `concat(0x44,0x52)`) evasions.
 *
 * These are matched against string-masked SQL (`maskStringLiterals`), so a
 * literal like `WHERE note = 'union select'` is NOT a false positive — the
 * masked scanner cannot see inside quotes, and that is exactly right: text in a
 * literal is data, not a clause.
 */
/**
 * Contextual probes: these functions are legitimate inside a real query but are
 * a fingerprint attempt when they ARE the query. `SELECT version()` discloses
 * the server build; `SELECT version FROM releases` reads a business column.
 *
 * The distinction must be structural because it cannot be lexical. Precedent:
 * `guardrails.test.ts` asserts `SELECT now(), version()` passes (it is a
 * plausible column list), while trial/fleet asserts the standalone
 * `SELECT version()` is blocked. Both are right, so the check is on the
 * whole-statement shape: a SELECT whose projection is exactly one probe call
 * with no FROM table is reconnaissance, not a data question.
 */
const BARE_PROBE_RE = /^\s*SELECT\s+(version|user|current_user|session_user|system_user|database|schema|pg_version)\s*\(\s*\)\s*(;\s*)?$/i

/**
 * A SELECT whose projection is ONLY literal constants, with no FROM clause.
 *
 * MEASURED IN UAT, and it is the worst shape this file has had to handle: asked for data that does not exist
 * ("berapa jumlah supplier?" against three databases with no supplier table), the model produced
 *
 *     SELECT 0 AS "jumlah_supplier" LIMIT 100
 *
 * and that ran. It reads NOTHING, yet the answer was rendered to the user under a DATABASE citation with a
 * `query_used` field — so a fabricated number arrived dressed as a data-backed one, with a SQL statement as the
 * evidence. That is worse than an empty answer: it is an invented fact with a receipt.
 *
 * WHY NOT SIMPLY "NO FROM": `SELECT 1` is the connectivity probe this codebase runs against every connector
 * (`connectors.ts`), and `SELECT now()` is a legitimate clock check. Both must keep working. The distinguishing
 * feature of the fabricated case is not "no table" but **a LITERAL GIVEN A BUSINESS NAME** — `0 AS "jumlah_supplier"`.
 * An unaliased `SELECT 1` claims nothing; an aliased literal asserts a fact about a quantity the query never read.
 *
 * So the rule is: a NUMERIC bare-literal projection, with no FROM, where at least one item carries an ALIAS — the
 * shape `0 AS "jumlah_supplier"` takes. It blocks every fabricated answer observed while leaving the probes intact.
 *
 * WHY NUMERIC ONLY, and a test settled this rather than my judgement: the first version also rejected
 * `SELECT 'pg_read_file(' AS note`, which the guardrails suite already covers as a LEGITIMATE admin note. A numeric
 * literal with a business alias asserts a QUANTITY the query never read (`0 AS "jumlah_supplier"` is a claim about
 * how many suppliers exist); a string literal with an alias is a label, and labels are not measurements.
 *
 * Returns the offending text so the caller can report it, or null when the query is fine.
 */
export function detectFabricatedConstantSelect(sql: string): string | null {
  const trimmed = sql.trim()
  if (!/^select\b/i.test(trimmed)) return null

  /*
   * THREE SHAPES, all measured in UAT round 2, and the first version of this function caught only the first:
   *
   *   1. `SELECT 0 AS "jumlah_supplier" LIMIT 100`                        no FROM, literal alias
   *   2. `SELECT 0::bigint AS "jumlah_supplier" LIMIT 100`                the same with a CAST
   *   3. `SELECT COUNT(*) AS "jumlah_pemasok" FROM "gudang" WHERE 1 = 0`  a real table, negated predicate
   *
   * Bypass 2 shipped in the first fix because the numeric check accepted only a bare integer, so `0::bigint` was
   * invisible to it. Bypass 3 shipped because the function returned early on ANY `FROM`, leaving every predicate to
   * the other guards -- none of which object to `WHERE FALSE`.
   *
   * All three produce a result that CANNOT depend on the data and is then presented as a database fact. That is the
   * defect, regardless of which route the SQL takes to get there.
   */

  // --- Shape 3: a predicate that is provably false, so the query's result is independent of the data. ---
  const FALSY = /\bwhere\s+(?:1\s*=\s*0|1\s*!=\s*1|false|0\s*=\s*1|true\s*=\s*false)\b/i
  if (FALSY.test(trimmed)) return trimmed

  // --- Shapes 1 and 2: no FROM at all, projecting a LITERAL (optionally CAST) with an alias. ---
  if (/\bfrom\b/i.test(trimmed)) return null
  // Strip a trailing LIMIT so `SELECT 0 AS x LIMIT 100` still matches.
  const withoutLimit = trimmed.replace(/\s*limit\s+\d+\s*;?\s*$/i, '')
  const projection = withoutLimit.replace(/^select\s+/i, '').replace(/\s*;\s*$/, '')
  if (!projection) return null
  // Every item must be a NUMERIC literal, and at least one must be ALIASED. The alias is what turns a number into
  // a claim (`0 AS "jumlah_supplier"`); an unaliased `SELECT 1` is the health probe this codebase relies on, and a
  // STRING literal is a label rather than a measurement, so neither is touched.
  const items = projection.split(',').map((raw) => raw.trim())
  let sawAlias = false
  const allNumericLiterals = items.every((item) => {
    const m = item.match(/^(.*?)\s+as\s+(.+)$/i)
    if (m) sawAlias = true
    // Trim a PostgreSQL CAST so `0::bigint` is recognised as the bare literal it is. MEASURED bypass: the first
    // version accepted only `0`, so `0::bigint AS "jumlah_supplier"` walked straight through.
    const value = (m ? m[1] : item).trim().replace(/::\s*[a-z0-9_\[\] ]+$/i, '').trim()
    return /^-?\d+(\.\d+)?$/.test(value)
  })
  return allNumericLiterals && sawAlias ? trimmed : null
}

const INJECTION_SHAPES: Array<{ re: RegExp; label: string }> = [
  // Tautology / always-true predicates. The `\b` on the operator keeps
  // `WHERE tag = 'orderby'` and column names such as `android` out.
  { re: /\b(or|and)\s+\d+\s*=\s*\d+/i, label: 'tautology (numeric)' },
  { re: /\b(or|and)\s+0x[0-9a-f]+\s*=\s*0x[0-9a-f]+/i, label: 'tautology (hex)' },
  { re: /\b(or|and)\s+\(\s*\d+\s*=\s*\d+\s*\)/i, label: 'tautology (parenthesised)' },
  // UNION-based extraction. `UNION ALL SELECT` is the same attack.
  { re: /\bunion\b[\s\S]{0,40}\bselect\b/i, label: 'union select' },
  // Encoding evasions: a hex literal or char()/concat() built string used as a
  // predicate operand. Legitimate analytics queries use hex rarely and never
  // inside a WHERE comparison against a name column.
  { re: /=\s*0x[0-9a-f]{2,}/i, label: 'hex literal operand' },
  { re: /\b(char|chr)\s*\(\s*\d+\s*\)/i, label: 'char() encoding' },
  { re: /\bconcat\s*\(\s*0x/i, label: 'concat(hex) encoding' },
  // Comment-based clause termination.
  { re: /(--|#|\/\*)[^\n]*$/m, label: 'clause termination via comment' },
  // Stacked statement with a mutation behind it.
  { re: /;\s*(drop|delete|update|insert|alter|truncate|grant|create)\b/i, label: 'stacked mutation' },
]


/**
 * Replace the CONTENT of quoted literals with filler, preserving offsets and
 * quote structure, so regex scans cannot match text inside a string literal.
 */
function maskStringLiterals(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      out += ch
      i++
      while (i < sql.length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) { out += '__'; i += 2; continue }
          out += ch
          i++
          break
        }
        out += '_'
        i++
      }
      continue
    }
    /*
     * Backtick (MySQL) and bracket (MSSQL) identifiers are masked too, and this was a MEASURED
     * corruption before it was: `SELECT [Credit Limit 5000] FROM loans` was rewritten to
     * `SELECT [Credit LIMIT 100] FROM loans`, i.e. a DIFFERENT COLUMN NAME. That is worse than
     * corrupting a literal — a literal only changes a filter VALUE, while an identifier changes which
     * column is read, and an aliased one (`AS [Limit 5000]`) silently changes the result set's field
     * names while the query still succeeds. `[Credit Limit 5000]` and `[Limit 5000]` are ordinary
     * column names in exactly the finance/ERP schemas this product is deployed against.
     *
     * `[` IS AMBIGUOUS — it also opens a PostgreSQL ARRAY SUBSCRIPT (`tags[1]`), which must NOT be
     * treated as an identifier and must stay visible. The two are told apart by what the brackets
     * CONTAIN: an identifier holds a letter or a space, a subscript holds only digits/expressions.
     * Required here because masking `[1]` would hide a real `LIMIT`-shaped subscript from the guard.
     */
    if (ch === '`' || (ch === '[' && /^\[[^\]]*[A-Za-z ][^\]]*\]/.test(sql.slice(i)))) {
      const close = ch === '`' ? '`' : ']'
      out += ch
      i++
      while (i < sql.length) {
        if (sql[i] === close) {
          out += close
          i++
          break
        }
        out += '_'
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Names of side-effecting functions present in `sql` (string-literal-aware). */
export function detectDangerousFunctions(sql: string): string[] {
  // Double-quoted identifiers are unquoted before the scan: Postgres accepts `"pg_read_file"('/etc/passwd')` as the
  // same call, and MEASURED on 2026-10-04 that spelling passed every pattern below.
  // Unquoted BEFORE masking, because the mask blanks double-quoted text; an identifier inside a single-quoted literal
  // is still masked afterwards, so a literal mentioning a function stays data.
  const masked = maskStringLiterals(sql.replace(/"([A-Za-z_][A-Za-z0-9_$]*)"/g, '$1'))
  const found: string[] = []
  for (const { re, label } of DANGEROUS_FUNCTIONS) {
    if (re.test(masked)) found.push(label)
  }
  // Injection SHAPES share the same scan and the same masking, so a literal
  // containing "union select" is data and survives; a real UNION SELECT does
  // not. Kept in one function so there is no second, weaker copy of this scan
  // elsewhere — the duplicated-logic failure mode this file keeps repeating.
  for (const { re, label } of INJECTION_SHAPES) {
    if (re.test(masked)) found.push(label)
  }
  // String-tautology patterns are made ENTIRELY of literals, so they must be
  // scanned on the raw SQL — maskStringLiterals replaces the content and would
  // hide them. This is the one intentional exception to the masked scan.
  const tautology = /\b(or|and)\s+'([^']*)'\s*=\s*'\2'/i
  if (tautology.test(sql)) found.push('string tautology')
  // Standalone fingerprint probe — structural, not lexical (see BARE_PROBE_RE).
  if (BARE_PROBE_RE.test(sql.trim())) found.push('bare fingerprint probe')
  /*
   * A projection of nothing but literals, with no FROM. Runs in the same pre-scan as the other structural checks so
   * it is reported through the existing block path and audit row, rather than needing a second mechanism.
   */
  if (detectFabricatedConstantSelect(sql)) found.push('fabricated answer (query result cannot depend on the data)')
  return found
}

/** Tokenise SQL preserving keywords, identifiers, string literals. */
function tokenize(sql: string): string[] {
  // Strip trailing semicolon; we explicitly disallow internal semicolons elsewhere.
  const cleaned = sql.trim().replace(/;\s*$/, '')
  // Rough token stream: split on whitespace & punctuation but keep words.
  return cleaned.match(/'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_]*|\S/g) ?? []
}

/**
 * Walk the token stream and detect any node belonging to MUTATION_KEYWORDS.
 * This is the TS analogue of `sqlglot`'s `exp.Delete | exp.Update | ...` walk.
 */
/**
 * `options.provider` turns on the AST layer for that dialect (ClickHouse stays lexical-only), and `options.policy`
 * enforces per-role table/column access. Without a provider only the lexical layer runs — every PRODUCTION caller
 * passes one, which `invariants.test.ts` enforces, so the dialect-agnostic call is a unit-test seam for the scan. Order: lexical scan → AST → LIMIT clamp. The AST is used to VALIDATE only;
 * the query that runs is the model's text with the lexical LIMIT clamp, never a re-serialised tree, so validation
 * cannot change what a query means.
 */
export function validateAndSanitizeLlmSql(generatedSql: string, options: AstGuardOptions = {}): GuardrailResult {
  const detected: string[] = []
  if (!generatedSql || !generatedSql.trim()) {
    return { ok: false, sanitized: '', reason: 'Empty query.' }
  }

  // 1. Dangerous pattern pre-scan
  for (const { re, label } of DANGEROUS_PATTERNS) {
    if (re.test(generatedSql)) {
      detected.push(label)
    }
  }
  // 1b. Side-effecting function scan (pg_read_file, dblink, file(), …). Runs
  // against masked SQL so literals can't produce false positives or hide a call.
  for (const label of detectDangerousFunctions(generatedSql)) {
    detected.push(label)
  }
  if (detected.length > 0) {
    inc('guardrail_blocks_total', { type: 'dangerous_pattern' })
    return {
      ok: false,
      sanitized: '',
      reason: `Security violation: dangerous pattern detected — ${detected.join(', ')}.`,
      detectedNodes: detected,
    }
  }

  const tokens = tokenize(generatedSql)
  if (tokens.length === 0) {
    return { ok: false, sanitized: '', reason: 'Tokenization failed.' }
  }

  // 2. Leading keyword must be SELECT or WITH (CTE) — everything else rejected.
  const head = tokens[0].toUpperCase()
  if (head !== 'SELECT' && head !== 'WITH') {
    return {
      ok: false,
      sanitized: '',
      reason: `Only SELECT/WITH is allowed. Found: ${head}.`,
      detectedNodes: [head],
    }
  }

  // 3. Walk tokens, look for mutation keywords outside string literals.
  let inStr = false
  let strCh = ''
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (inStr) {
      if (t === strCh) inStr = false
      continue
    }
    if (t === "'" || t === '"') {
      inStr = true
      strCh = t
      continue
    }
    const up = t.toUpperCase()
    if (MUTATION_KEYWORDS.has(up)) {
      detected.push(up)
    }
    // INTO after SELECT (e.g. SELECT ... INTO new_table) is a creation — block.
    if (up === 'INTO') {
      detected.push('INTO')
    }
  }

  if (detected.length > 0) {
    inc('guardrail_blocks_total', { type: 'mutation_keyword' })
    return {
      ok: false,
      sanitized: '',
      reason: `Security violation: AI is not allowed to modify data (${detected.join(', ')}).`,
      detectedNodes: detected,
    }
  }

  // 3b. Parse. A real parse sees what the scan cannot: the base tables and columns read (for per-role access), every
  // function call as a node, SELECT … INTO, and statement shape. Fail-closed on an unparseable query.
  const ast = options.provider ? checkSqlAst(generatedSql, options) : null
  if (ast && !ast.ok) {
    inc('guardrail_blocks_total', { type: `ast_${ast.kind}` })
    return { ok: false, sanitized: '', reason: ast.reason, detectedNodes: ast.detectedNodes }
  }

  // 4. Re-compile & enforce a hard LIMIT cap (spec §4.3).
  let compiled = generatedSql.trim().replace(/;\s*$/, '')

  // Single-statement guarantee: after stripping the trailing ';', no internal
  // ';' may remain (already pre-scanned, but assert again as defence-in-depth).
  if (/;\s*\S/.test(compiled)) {
    return {
      ok: false,
      sanitized: '',
      reason: 'Security violation: multiple statements detected.',
      detectedNodes: [';'],
    }
  }

  /*
   * Clamp the ROW-COUNT clause to SQL_MAX_LIMIT. This lexical clamp is the ONLY row-count control in
   * the text-to-SQL pipeline, so the bypasses below were the whole cap rather than a detail of it.
   *
   * THREE MEASURED BYPASSES this replaces, each re-confirmed by executing the previous version:
   *
   *   LIMIT ALL / LIMIT NULL   the old pattern required DIGITS, so it matched nothing, and the
   *                            `/\bLIMIT\b/` append-guard then found the word "LIMIT" and skipped the
   *                            cap. Two words defeated the only row bound. Both spellings now rewrite
   *                            TO the cap, because a non-numeric limit means "no bound at all".
   *   LIMIT 0, 1000000         MySQL's `LIMIT <offset>, <count>` — the old pattern clamped the FIRST
   *                            number, i.e. the OFFSET, and left the COUNT at a million. The count is
   *                            the row bound, so the count is what gets clamped.
   *   FETCH FIRST / TOP        the append-guard saw no `LIMIT` and appended one, producing
   *                            `... FETCH FIRST 1000000 ROWS ONLY LIMIT 100` and
   *                            `SELECT TOP 1000000 ... LIMIT 100` — the first is invalid on MSSQL
   *                            (`LIMIT` is not MSSQL syntax) and both are redundant. These spellings
   *                            are now clamped in place, and no `LIMIT` is appended when one of them
   *                            is already present.
   *
   * What this deliberately does NOT do: rewrite one clause spelling INTO another. An earlier attempt
   * built `LIMIT n OFFSET m` and substituted it positionally, which turned
   * `FETCH FIRST 1000000 ROWS ONLY` into `LIMIT 1000000 OFFSET 0 ONLY` and
   * `SELECT TOP 1000000 id` into `SELECT TOP LIMIT 1000000 OFFSET 0 id` — syntactically broken in both
   * dialects, and worse than the bypass. This version only ever replaces a NUMBER, never structure.
   *
   * Still not covered, and not fixable at this layer: cartesian joins, `SELECT *`, and work
   * amplification such as `generate_series(1, 100000000)` — LIMIT bounds ROWS RETURNED, not the work
   * the server does. `OFFSET` is left alone throughout: clamping it changes which rows come back
   * without bounding how many, so it is not a cap.
   */

  // Presence checks are taken BEFORE any rewrite, so an appended cap can never be mistaken for one the
  // model already wrote.
  //
  // `TOP` counts as a row limit ONLY when it directly follows the leading SELECT: deeper in the text it
  // is an ordinary column name (`SELECT top FROM parts`), and clamping that would rewrite a reference.
  // Clamp over the STRING-MASKED SQL, then apply the edits back onto the original by index.
  //
  // WHY MASKING IS MANDATORY HERE — a measured corruption, not a precaution. The clamp used to run
  // on the RAW text, so a limit-looking value INSIDE A STRING LITERAL was rewritten:
  // `WHERE note = 'LIMIT 999999'` became `WHERE note = 'LIMIT 100'`, silently changing the value the
  // query compares against — an answer the model never asked for, in a statement that still parses.
  // `maskStringLiterals` blanks literal CONTENT (keeping the quotes and length), so a `LIMIT` inside
  // a literal can no longer be seen as a clause. Indices are preserved by that helper, which is what
  // makes the in-place edits below safe.
  const masked = maskStringLiterals(compiled)
  const edits: { start: number; end: number; text: string }[] = []
  const rewrite = (re: RegExp, make: (...groups: string[]) => string) => {
    re.lastIndex = 0
    for (let m = re.exec(masked); m; m = re.exec(masked)) {
      edits.push({ start: m.index, end: m.index + m[0].length, text: make(...m.slice(1)) })
    }
  }

  // The 1..100-char bound keeps the match near the start of the list.
  //
  // NOTE these presence checks read the MASKED text for the same reason. They must also run BEFORE any
  // rewrite, so an appended cap can never be mistaken for one the model wrote.
  const hasFetch = /\bFETCH\s+(?:FIRST|NEXT)\b/i.test(masked)
  const hasTop = /\bSELECT\s{1,100}TOP\s*\(?\s*[\d_]/i.test(masked)
  const hasLimit = /\bLIMIT\b/i.test(masked)

  // A numeric literal, in every spelling PostgreSQL/MySQL accept: plain digits, `_` digit separators
  // (`1_000_000`) and exponent form (`1e10`). All three were MEASURED unbounded before this: the
  // digits-only pattern matched none of them, and the append-guard then saw the word `LIMIT` and
  // skipped the cap. `Number('1_000_000')` is NaN in JS, so separators are stripped before
  // converting; `Number('1e10')` is already correct.
  // The FULL literal, including a fraction. `[\\d_]+(?:[eE]...)?` matched only the integer part of
  // `1.9e9`, so the rewrite produced `LIMIT 1.9e9` from its own "clamp" and left the statement
  // unbounded — MEASURED on PostgreSQL 16 (500000-row series, full set returned).
  const NUM = '[\\d_]+(?:\\.[\\d_]+)?(?:[eE][+-]?[\\d_]+)?'
  // `(?!\\w|\\.)` is the difference between clamping a number and clamping PART of one: with a bare
  // `\\b`, `LIMIT 1000000.5e2` rewrote the `1000000` and left `100.5e2` = 10050 rows, MEASURED.
  const LIT = `${NUM}(?![\\w.])`
  const toNum = (raw: string) => Number(String(raw).replace(/_/g, ''))
  // A number this layer cannot evaluate is emitted VERBATIM, never as `LIMIT NaN`.
  const clampText = (raw: string) => {
    const n = toNum(raw)
    return Number.isFinite(n) ? String(Math.min(n, SQL_MAX_LIMIT)) : raw
  }

  // 1. `LIMIT ALL` / `LIMIT NULL` bound nothing — rewrite to the cap. Group 1 keeps the spelling out
  // of the way so the replacement is uniform.
  rewrite(/\bLIMIT\s+(?:ALL|NULL)\b/gi, () => `LIMIT ${SQL_MAX_LIMIT}`)

  // 2. MySQL `LIMIT <offset>, <count>` — clamp the COUNT (second number), keep the offset. The offset
  // is not a bound: reducing it changes WHICH rows return without bounding HOW MANY.
  rewrite(
    new RegExp(`\\bLIMIT\\s+(${LIT})\\s*,\\s*(${LIT})`, 'gi'),
    (off, count) => `LIMIT ${off}, ${clampText(count)}`,
  )

  // 3. `LIMIT <count> [OFFSET <n>]` — clamp the count, keep the offset.
  //
  // The `(?!\s*,)` lookahead is load-bearing: without it this rule also matches the FIRST number of a
  // MySQL `LIMIT <off>, <count>` and clamps the OFFSET — measured producing `LIMIT 100, 100` from
  // `LIMIT 500000, 2000000`. A comma after the number means the form is rule 2's, not this one's.
  // (A lookahead is ES5; only lookBEHIND needs ES2018, which this repo's target forbids.)
  rewrite(
    new RegExp(`\\bLIMIT\\s+(${LIT})(?!\\s*,)(?:\\s+OFFSET\\s+(${LIT}))?`, 'gi'),
    (n, off) => {
      return off !== undefined ? `LIMIT ${clampText(n)} OFFSET ${off}` : `LIMIT ${clampText(n)}`
    },
  )

  // 4. `FETCH FIRST|NEXT <n> ROWS ONLY` — clamp the count IN PLACE, leaving the spelling intact.
  rewrite(
    // `WITH TIES` is a SECOND spelling of this clause and was left uncapped: MEASURED on PostgreSQL 16,
    // `ORDER BY 1 FETCH FIRST 1000000 ROWS WITH TIES` returned all 500000 rows while the guardrail
    // reported success. Rewritten to `ONLY`, not merely renumbered, because ties ADD rows past the
    // count — `WITH TIES` cannot express a hard cap at all.
    new RegExp(`\\b(FETCH\\s+(?:FIRST|NEXT)\\s+)(${LIT})(\\s+ROWS?\\s+)(ONLY|WITH\\s+TIES)`, 'gi'),
    (head, n, rows, mode) => `${head}${clampText(n)}${rows}${/^with/i.test(mode) ? 'ONLY' : mode}`,
  )

  // 5. MSSQL `TOP <n>` / `TOP (<n>)` after the leading SELECT — clamp the count in place.
  rewrite(
    new RegExp(`\\b(SELECT\\s{1,100}TOP\\s*\\(?\\s*)(${LIT})`, 'gi'),
    (head, n) => `${head}${clampText(n)}`,
  )

  // Apply every edit right-to-left so earlier indices stay valid as later text changes length.
  edits.sort((a, b) => b.start - a.start)
  for (const e of edits) compiled = compiled.slice(0, e.start) + e.text + compiled.slice(e.end)

  // Append the cap ONLY when no row-limit clause exists in ANY spelling the databases understand.
  // Testing for the word `LIMIT` alone is what appended a second, invalid clause after FETCH/TOP.
  //
  // KNOWN CONSEQUENCE, stated because it is a real behaviour change and not an oversight: a statement
  // whose only `TOP` is a COLUMN REFERENCE (`SELECT top FROM parts`) has no row limit, so the cap is
  // appended — `... FROM parts LIMIT 100`. Appending the cap to any limit-less SELECT is the
  // established contract here (a HEAD-era test pins "missing LIMIT -> appended as LIMIT 100"), and on
  // a UNIQUE column it is a no-op. On a NON-unique one it changes the result to the first 100 rows.
  // The alternative — treating a bare `top` as a row limit — would be wrong in the other direction:
  // it would suppress the cap on every statement that merely mentions the word, which is the bypass
  // this whole function exists to close.
  if (!hasLimit && !hasFetch && !hasTop) {
    compiled = `${compiled} LIMIT ${SQL_MAX_LIMIT}`
  }
  compiled = `${compiled};`

  return { ok: true, sanitized: compiled }
}

/** Quick classify: does this look like a query the AI intended to run? */
export function looksLikeSql(text: string): boolean {
  const t = text.trim().toUpperCase()
  return t.startsWith('SELECT') || t.startsWith('WITH')
}
