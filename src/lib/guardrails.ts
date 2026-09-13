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

const DANGEROUS_FUNCTIONS: Array<{ re: RegExp; label: string }> = [
  // Postgres
  { re: /\bpg_read_(file|binary_file)\s*\(/i, label: 'pg_read_file' },
  { re: /\bpg_write_file\s*\(/i, label: 'pg_write_file' },
  { re: /\bpg_ls_dir\s*\(/i, label: 'pg_ls_dir' },
  { re: /\bpg_stat_file\s*\(/i, label: 'pg_stat_file' },
  { re: /\blo_(import|export)\s*\(/i, label: 'lo_import/lo_export' },
  { re: /\bdblink(_connect)?\s*\(/i, label: 'dblink' },
  { re: /\bpg_sleep(_for|_until)?\s*\(/i, label: 'pg_sleep' },
  { re: /\bset_config\s*\(/i, label: 'set_config' },
  { re: /\bpostgres_fdw\b/i, label: 'postgres_fdw' },
  // MySQL
  { re: /\bload_file\s*\(/i, label: 'load_file' },
  { re: /\bsleep\s*\(/i, label: 'sleep' },
  { re: /\bbenchmark\s*\(/i, label: 'benchmark' },
  // MSSQL
  // MEASURED GAP, NOW CLOSED. `real-connectors.ts` documented that
  // `assertNoDangerousFunctions` "blocks xp_cmdshell / OPENROWSET / BULK INSERT / OPENDATASOURCE", and the other
  // three WERE listed here while `xp_cmdshell` was not: probed directly, `EXEC master..xp_cmdshell 'whoami'`,
  // `SELECT xp_cmdshell ON x`, and `SELECT xp_cmdshell('whoami')` all returned an EMPTY detection list. That is the
  // single most valuable MSSQL primitive for an attacker -- arbitrary OS command execution as the SQL service
  // account -- so a comment asserting it was blocked was worse than no comment at all.
  //
  // Matched WITHOUT a following `(` on purpose: the classic form is an extended stored procedure invoked as
  // `EXEC master..xp_cmdshell 'cmd'`, which has no parenthesis after the name.
  { re: /\bxp_cmdshell\b/i, label: 'xp_cmdshell' },
  // Sibling extended procedures reachable the same way. `sp_configure` is the documented route to re-ENABLE
  // xp_cmdshell on a server where an operator turned it off, so it belongs in the same family.
  { re: /\bsp_configure\b/i, label: 'sp_configure' },
  { re: /\bxp_reg(read|write|deletevalue|addmultistring|enumvalues)\b/i, label: 'xp_reg*' },
  { re: /\bxp_servicecontrol\b/i, label: 'xp_servicecontrol' },
  { re: /\bxp_dirtree\b|\bxp_fileexist\b|\bxp_subdirs\b/i, label: 'xp_dirtree/xp_fileexist' },
  { re: /\bsp_OACreate\b|\bsp_OAMethod\b|\bsp_OAGetProperty\b|\bsp_OADestroy\b/i, label: 'sp_OA* (OLE automation)' },
  { re: /\bopenrowset\s*\(/i, label: 'openrowset' },
  { re: /\bopendatasource\s*\(/i, label: 'opendatasource' },
  { re: /\bopenquery\s*\(/i, label: 'openquery' },
  { re: /\bbulk\s+insert\b/i, label: 'bulk insert' },
  // ClickHouse table functions
  { re: /\b(url|file|s3|hdfs|remote|remoteSecure|mysql|postgresql|jdbc|odbc|input)\s*\(/i, label: 'ClickHouse table function' },
  // ponytail: server-fingerprint probes. `SELECT @@version` passed every other
  // rule — it is a bare SELECT with no mutation and no known function — yet it
  // is step one of fingerprinting a server to pick an exploit, and it returns
  // data the user never asked for. Found by trial/fleet (case D3-gb-22), which
  // is the point of running the fleet: no rule matched, so nothing else would
  // have caught it.
  { re: /(^|[^\w@])@@\s*[a-z_]/i, label: 'system variable probe (@@var)' },
  // NOTE: these four are contextual — see BARE_PROBES below. `version()`
  // appearing as ONE column of a business query is normal SQL; `SELECT
  // version()` on its own is a fingerprint probe. Regex alone cannot tell them
  // apart, so the whole-statement shape is checked separately.
  { re: /\bcurrent_user\b|\bsession_user\b|\bsystem_user\b/i, label: 'identity probe' },
  { re: /\bpg_postmaster_start_time\s*\(/i, label: 'pg_postmaster_start_time' },
  { re: /\binet_server_addr\s*\(|\binet_server_port\s*\(/i, label: 'server address probe' },
  // ponytail: second wave of fingerprint probes, all found by the 518-case
  // trial/fleet run — each is a bare SELECT with no mutation and no
  // side-effecting function, so nothing in the earlier list matched:
  //   SELECT database() / schema() / user()  -> env & identity disclosure
  //   SELECT pg_version()                    -> version disclosure
  //   ... WHERE name = waitfor delay         -> MSSQL time-based blind injection
  //   SELECT updatexml(...) / extractvalue() -> MySQL error-based extraction
  //   SELECT case when 1=1 then ...          -> boolean-blind probe
  //   SELECT if(1=1,sleep(5),0)              -> MySQL time-based blind
  { re: /\bpg_version\s*\(/i, label: 'pg_version probe' },


  { re: /\bwaitfor\s+delay\b/i, label: 'MSSQL waitfor delay' },
  { re: /\bupdatexml\s*\(|\bextractvalue\s*\(/i, label: 'MySQL error extraction' },
  { re: /\bcase\s+when\b[\s\S]*\bthen\b[\s\S]*\bend\b/i, label: 'boolean-blind CASE probe' },
  { re: /\bif\s*\([^)]*\b(sleep|benchmark|pg_sleep)\s*\(/i, label: 'MySQL time-based blind' },
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
    out += ch
    i++
  }
  return out
}

/** Names of side-effecting functions present in `sql` (string-literal-aware). */
export function detectDangerousFunctions(sql: string): string[] {
  const masked = maskStringLiterals(sql)
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
export function validateAndSanitizeLlmSql(generatedSql: string): GuardrailResult {
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

  // Clamp any existing LIMIT n / LIMIT n OFFSET m down to SQL_MAX_LIMIT.
  compiled = compiled.replace(
    /\bLIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?/gi,
    (_m, n, off) => {
      const clamped = Math.min(Number(n), SQL_MAX_LIMIT)
      return off !== undefined ? `LIMIT ${clamped} OFFSET ${off}` : `LIMIT ${clamped}`
    },
  )
  // If (still) no LIMIT, append the cap.
  if (!/\bLIMIT\b/i.test(compiled)) {
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
