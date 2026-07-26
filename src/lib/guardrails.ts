/**
 * 4.3 — Guardrails: AST Anti-SQL-Injection & Mutation Guard
 * ----------------------------------------------------------------------------
 * Adapted from the spec's Python `sqlglot`-based validator. Because we run on
 * Node/Next.js, we implement an equivalent tokenizer + AST walker in pure TS.
 *
 * Enforced rules (mirrors spec §4.3):
 *   1. REJECT all DML/DDL mutation statements: DELETE, UPDATE, INSERT, DROP,
 *      ALTER, TRUNCATE, CREATE, GRANT, REVOKE, MERGE, CALL, EXEC.
 *   2. REJECT multiple statements separated by `;` after the first (injection guard).
 *   3. REJECT dangerous comments / hidden payloads (`--`, `/*`, `xp_`, `sp_`, `;`).
 *   4. REJECT `INTO`, `OUTPUT`, `BULK`, `LOAD_FILE`, `UNION` with system tables.
 *   5. Force a LIMIT 100 safety cap if no LIMIT is present.
 *   6. Whitelist only `SELECT` (with optional WITH/CTE) as the leading keyword.
 */
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
const MAX_LIMIT = 100

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
  { re: /\b(?:from|join)\s+["`]?(sqlite_master|sqlite_\w*|information_schema|mysql\.|pg_\w+|sys\.)["`]?/i, label: 'system/catalog table access' },
  { re: /\bunion\s+select\b.*\bfrom\s+(information_schema|mysql|pg_|sys\.|sqlite_)/i, label: 'system-table union scan' },
  { re: /\battach\s+database\b/i, label: 'SQLite attach database' },
]

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
  if (detected.length > 0) {
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

  // Clamp any existing LIMIT n / LIMIT n OFFSET m down to MAX_LIMIT.
  compiled = compiled.replace(
    /\bLIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?/gi,
    (_m, n, off) => {
      const clamped = Math.min(Number(n), MAX_LIMIT)
      return off !== undefined ? `LIMIT ${clamped} OFFSET ${off}` : `LIMIT ${clamped}`
    },
  )
  // If (still) no LIMIT, append the cap.
  if (!/\bLIMIT\b/i.test(compiled)) {
    compiled = `${compiled} LIMIT ${MAX_LIMIT}`
  }
  compiled = `${compiled};`

  return { ok: true, sanitized: compiled }
}

/** Quick classify: does this look like a query the AI intended to run? */
export function looksLikeSql(text: string): boolean {
  const t = text.trim().toUpperCase()
  return t.startsWith('SELECT') || t.startsWith('WITH')
}
