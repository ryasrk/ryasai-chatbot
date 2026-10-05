/**
 * AST validation of LLM-generated SQL, layered AFTER the lexical scanner in `guardrails.ts`.
 *
 * WHY A PARSER NOW. `guardrails.ts` is a hand-rolled token scan (its own header: "NOT a real SQL parser"). A scan can
 * reject words; it cannot say WHICH TABLES AND COLUMNS a query reads, so it could never enforce per-role data access,
 * and every new evasion needed another regex. A real parse answers both: one statement of type SELECT, the set of
 * base tables (CTE names subtracted), the columns, and every function call as a node.
 *
 * FAIL-CLOSED. A query the parser cannot read is REJECTED — the reason goes back to the repair loop, which regenerates.
 * MEASURED on 2026-10-04 before adopting this, through the full guard (lexical + AST): 137 of 138 distinct real
 * LLM-generated PostgreSQL queries from a development `QueryHistory`, and 480 of 480 benchmark gold queries, still
 * pass. The one miss was a CTE with a column list over `VALUES`, which the repair loop can express differently.
 * The same measurement found two queries the lexical scan alone let through (see sql-ast-guard.test.ts).
 *
 * ClickHouse is not supported by the parser and keeps the lexical layer plus the server's `readonly=1`.
 */
import { Parser } from 'node-sql-parser'
import { dangerousFunctionLabel } from '@/lib/sql-function-denylist'
import { DB_PROVIDER_PRESETS } from '@/lib/db-provider-presets'

/** Our provider ids → node-sql-parser dialect names. A provider absent here is not AST-checked. */
const DIALECTS: Record<string, string> = {
  POSTGRESQL: 'PostgresQL',
  MYSQL: 'MySQL',
  MARIADB: 'MariaDB',
  MSSQL: 'TransactSQL',
}

/**
 * The parser dialect for a provider id, including the managed presets (`SUPABASE`, `NEON`, `COCKROACHDB`,
 * `PLANETSCALE`, `TIDB`) through their protocol family.
 *
 * MEASURED before this lookup: the guard received the preset id, found no entry in `DIALECTS`, and returned
 * `checked: false`, so for those five providers neither the per-role table/column policy nor the parsed checks ran
 * (`SELECT salary FROM secret_table` passed with a policy allowing one column of another table). An id that is
 * neither listed nor a preset stays unchecked, as before.
 */
function dialectFor(provider: string | undefined): string | undefined {
  const id = String(provider ?? '').toUpperCase()
  if (DIALECTS[id]) return DIALECTS[id]
  const family = DB_PROVIDER_PRESETS.find((p) => p.id === id)?.family
  return family ? DIALECTS[family] : undefined
}

/** Schemas no business question needs, and whose contents describe the server rather than the data. */
const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast', 'sys', 'mysql', 'performance_schema', 'msdb', 'master', 'tempdb', 'model'])

/** Postgres resolves `pg_*` relations through `pg_catalog` WITHOUT a schema prefix (`SELECT * FROM pg_user`). */
const SYSTEM_TABLE = /^(pg_|sys(objects|columns|users|logins|databases|servers)$)/i

/**
 * Per-table access for ONE role on ONE integration, in restricted mode.
 * A table absent from `tables` is denied. `allowedColumns: null` allows every column of that table.
 */
export interface SqlAccessPolicy {
  tables: ReadonlyMap<string, { allowedColumns: ReadonlySet<string> | null }>
}

export interface AstGuardOptions {
  /** The integration's provider (`POSTGRESQL`, `MYSQL`, `MSSQL`, `CLICKHOUSE`, …). */
  provider?: string
  /** Restricted-mode policy; `null`/absent = no table or column restriction. */
  policy?: SqlAccessPolicy | null
  /**
   * Reflected columns per table (lowercase), used to attribute an UNQUALIFIED column to the tables that actually have
   * it. Without it an unqualified column is attributed to every referenced table (stricter, never looser).
   */
  schemaColumns?: ReadonlyMap<string, ReadonlySet<string>>
}

export type AstGuardResult =
  | { ok: true; checked: boolean; tables: string[] }
  | {
      ok: false
      kind: 'parse' | 'statement' | 'system_schema' | 'function' | 'into' | 'access'
      reason: string
      detectedNodes: string[]
    }

const parser = new Parser()

const lower = (s: unknown) => String(s ?? '').toLowerCase()

/** `type::schema::table` / `type::table::column` → parts, with node-sql-parser's literal `null` mapped to null. */
function split(entry: string): [string | null, string] {
  const parts = entry.split('::')
  const mid = parts[1] === 'null' ? null : parts[1]
  return [mid, parts.slice(2).join('::')]
}

function functionName(node: Record<string, unknown>): string | null {
  const name = node.name as unknown
  if (typeof name === 'string') return name
  if (name && typeof name === 'object') {
    const parts = (name as { name?: Array<{ value?: unknown }> }).name
    if (Array.isArray(parts)) return parts.map((p) => String(p?.value ?? '')).filter(Boolean).join('.')
  }
  return null
}

/** Every node in the AST, iteratively (a deeply nested query must not overflow the stack). */
function* nodes(root: unknown): Generator<Record<string, unknown>> {
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object') continue
    if (Array.isArray(cur)) {
      for (const c of cur) stack.push(c)
      continue
    }
    const obj = cur as Record<string, unknown>
    yield obj
    for (const v of Object.values(obj)) if (v && typeof v === 'object') stack.push(v)
  }
}

/**
 * Rewrite `"name"` to `` `name` `` outside strings and comments, so the guard parses a MySQL-family query the way the
 * SERVER runs it.
 *
 * WHY: the MySQL connector turns on ANSI_QUOTES per session (`enableAnsiQuotes`), so `"salary"` there is a COLUMN.
 * node-sql-parser in MySQL/MariaDB mode reads it as a STRING. MEASURED before this rewrite: with `salary` denied to the
 * role, `WHERE "salary" > 100` and `ORDER BY "salary" DESC LIMIT 1` passed the policy check, and on the server they
 * filter and sort by the real column, so the role could read the column one comparison at a time. If a server refuses
 * ANSI_QUOTES, the rewrite only makes the guard stricter: a string literal is checked as if it were a column.
 */
export function ansiQuotesToBackticks(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === "'" || c === '`') {
      // Copied verbatim. A single-quoted string ends at an unescaped quote ('' and \' are escapes), a backticked
      // name at an unpaired backtick.
      let j = i + 1
      while (j < sql.length) {
        if (c === "'" && sql[j] === '\\') { j += 2; continue }
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue }
          break
        }
        j++
      }
      out += sql.slice(i, j + 1)
      i = j + 1
    } else if (c === '"') {
      let name = ''
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { name += '"'; j += 2; continue }
          break
        }
        name += sql[j]
        j++
      }
      out += '`' + name.replace(/`/g, '``') + '`'
      i = j + 1
    } else if ((c === '-' && next === '-') || c === '#') {
      const end = sql.indexOf('\n', i)
      const stop = end === -1 ? sql.length : end
      out += sql.slice(i, stop)
      i = stop
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      const stop = end === -1 ? sql.length : end + 2
      out += sql.slice(i, stop)
      i = stop
    } else {
      out += c
      i++
    }
  }
  return out
}

export function checkSqlAst(sql: string, opts: AstGuardOptions = {}): AstGuardResult {
  const dialect = dialectFor(opts.provider)
  if (!dialect) return { ok: true, checked: false, tables: [] }

  const trimmed = sql.trim().replace(/;\s*$/, '')
  // MySQL-family sessions run with ANSI_QUOTES; see `ansiQuotesToBackticks`.
  const text = dialect === 'MySQL' || dialect === 'MariaDB' ? ansiQuotesToBackticks(trimmed) : trimmed
  let ast: unknown
  try {
    ast = parser.astify(text, { database: dialect })
  } catch {
    return {
      ok: false,
      kind: 'parse',
      reason: 'The SQL could not be parsed for validation. Rewrite it as one plain SELECT (CTEs, joins and subqueries are fine).',
      detectedNodes: ['unparseable'],
    }
  }
  const statements = Array.isArray(ast) ? ast : [ast]
  if (statements.length !== 1) {
    return { ok: false, kind: 'statement', reason: 'Exactly one statement is allowed.', detectedNodes: [`${statements.length} statements`] }
  }
  const root = statements[0] as Record<string, unknown>
  if (root.type !== 'select') {
    return { ok: false, kind: 'statement', reason: `Only SELECT is allowed. Found: ${String(root.type).toUpperCase()}.`, detectedNodes: [String(root.type)] }
  }

  // One pass over the tree: CTE names, SELECT … INTO, and every function call.
  const cteNames = new Set<string>()
  const functions: string[] = []
  for (const node of nodes(root)) {
    if (Array.isArray(node.with)) {
      for (const cte of node.with as Array<{ name?: { value?: unknown } | string }>) {
        const n = typeof cte?.name === 'string' ? cte.name : cte?.name?.value
        if (n) cteNames.add(lower(n))
      }
    }
    if (node.type === 'select' && node.into && typeof node.into === 'object' && (node.into as { expr?: unknown }).expr) {
      return { ok: false, kind: 'into', reason: 'SELECT … INTO creates a table and is not allowed.', detectedNodes: ['INTO'] }
    }
    if (node.type === 'function') {
      const name = functionName(node)
      if (name) functions.push(name)
    }
  }

  const blockedFunctions = functions
    .map((f) => dangerousFunctionLabel(f.split('.').pop() ?? f))
    .filter((l): l is string => l !== null)
  if (blockedFunctions.length > 0) {
    return {
      ok: false,
      kind: 'function',
      reason: `Security violation: side-effecting function — ${[...new Set(blockedFunctions)].join(', ')}.`,
      detectedNodes: [...new Set(blockedFunctions)],
    }
  }

  // Base tables: everything the parser lists, minus CTE references.
  const baseTables: Array<{ schema: string | null; table: string }> = []
  for (const entry of parser.tableList(text, { database: dialect })) {
    const [schema, table] = split(entry)
    const t = lower(table)
    if (!schema && cteNames.has(t)) continue
    baseTables.push({ schema: schema ? lower(schema) : null, table: t })
  }
  const systemRefs = baseTables.filter((t) => (t.schema && SYSTEM_SCHEMAS.has(t.schema)) || SYSTEM_TABLE.test(t.table))
  if (systemRefs.length > 0) {
    return {
      ok: false,
      kind: 'system_schema',
      reason: 'System catalogs are not queryable. Use only the business tables in the provided schema.',
      detectedNodes: systemRefs.map((t) => (t.schema ? `${t.schema}.${t.table}` : t.table)),
    }
  }
  const tables = [...new Set(baseTables.map((t) => t.table))]

  if (opts.policy) {
    const denied = checkPolicy(text, dialect, tables, cteNames, opts.policy, opts.schemaColumns)
    if (denied) return denied
  }
  return { ok: true, checked: true, tables }
}

function checkPolicy(
  text: string,
  dialect: string,
  tables: string[],
  cteNames: ReadonlySet<string>,
  policy: SqlAccessPolicy,
  schemaColumns: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): AstGuardResult | null {
  const deniedTables = tables.filter((t) => !policy.tables.has(t))
  if (deniedTables.length > 0) {
    return {
      ok: false,
      kind: 'access',
      reason: `Access denied: your role may not query ${deniedTables.join(', ')}. Use only the tables in the provided schema.`,
      detectedNodes: deniedTables.map((t) => `table:${t}`),
    }
  }

  const restricted = (t: string) => policy.tables.get(t)?.allowedColumns ?? null
  const deniedColumns: string[] = []
  for (const entry of parser.columnList(text, { database: dialect })) {
    const [owner, rawColumn] = split(entry)
    const column = lower(rawColumn)
    const star = column === '(.*)'
    const ownerTable = owner ? lower(owner) : null

    // A column qualified by a CTE is the CTE's output; the CTE body's own columns are checked as their own entries.
    if (ownerTable && cteNames.has(ownerTable)) continue

    const candidates = ownerTable && tables.includes(ownerTable)
      ? [ownerTable]
      : tables.filter((t) => !schemaColumns?.get(t) || star || schemaColumns.get(t)!.has(column))
    for (const t of candidates) {
      const allowed = restricted(t)
      if (allowed === null) continue
      if (star) deniedColumns.push(`${t}.*`)
      else if (!allowed.has(column)) deniedColumns.push(`${t}.${column}`)
    }
  }
  if (deniedColumns.length > 0) {
    const unique = [...new Set(deniedColumns)]
    const hasStar = unique.some((c) => c.endsWith('.*'))
    return {
      ok: false,
      kind: 'access',
      reason:
        `Access denied: your role may not read ${unique.filter((c) => !c.endsWith('.*')).join(', ') || 'every column'}` +
        (hasStar ? '. Name the allowed columns explicitly instead of using *.' : '.') +
        ' Use only the columns in the provided schema.',
      detectedNodes: unique.map((c) => `column:${c}`),
    }
  }
  return null
}
