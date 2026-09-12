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
  { re: /\bopenrowset\s*\(/i, label: 'openrowset' },
  { re: /\bopendatasource\s*\(/i, label: 'opendatasource' },
  { re: /\bbulk\s+insert\b/i, label: 'bulk insert' },
  // ClickHouse table functions
  { re: /\b(url|file|s3|hdfs|remote|remoteSecure|mysql|postgresql|jdbc|odbc|input)\s*\(/i, label: 'ClickHouse table function' },
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
