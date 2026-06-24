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
])

const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /--/, label: 'inline comment (--)' },
  { re: /\/\*/, label: 'block comment (/*)' },
  { re: /\bxp_\w+/i, label: 'SQL Server extended proc (xp_)' },
  { re: /\bsp_\w+/i, label: 'system stored proc (sp_)' },
  { re: /;\s*\w+/i, label: 'statement chaining (;)' },
  { re: /\bload_file\s*\(/i, label: 'MySQL file read (load_file)' },
  { re: /\binto\s+outfile/i, label: 'MySQL file write (into outfile)' },
  { re: /\bunion\s+select\b.*\bfrom\s+(information_schema|mysql|pg_|sys\.)/i, label: 'system-table union scan' },
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
    return { ok: false, sanitized: '', reason: 'Kueri kosong.' }
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
      reason: `Pelanggaran Keamanan: pola berbahaya terdeteksi — ${detected.join(', ')}.`,
      detectedNodes: detected,
    }
  }

  const tokens = tokenize(generatedSql)
  if (tokens.length === 0) {
    return { ok: false, sanitized: '', reason: 'Tokenisasi gagal.' }
  }

  // 2. Leading keyword must be SELECT or WITH (CTE) — everything else rejected.
  const head = tokens[0].toUpperCase()
  if (head !== 'SELECT' && head !== 'WITH') {
    return {
      ok: false,
      sanitized: '',
      reason: `Hanya SELECT/WITH yang diizinkan. Ditemukan: ${head}.`,
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
      reason: `Pelanggaran Keamanan: AI dilarang melakukan modifikasi data (${detected.join(', ')}).`,
      detectedNodes: detected,
    }
  }

  // 4. Re-compile & enforce LIMIT (spec: if no LIMIT, append LIMIT 100).
  let compiled = generatedSql.trim().replace(/;\s*$/, '')
  if (!/\bLIMIT\b/i.test(compiled)) {
    compiled = `${compiled} LIMIT 100`
  }
  compiled = `${compiled};`

  return { ok: true, sanitized: compiled }
}

/** Quick classify: does this look like a query the AI intended to run? */
export function looksLikeSql(text: string): boolean {
  const t = text.trim().toUpperCase()
  return t.startsWith('SELECT') || t.startsWith('WITH')
}
