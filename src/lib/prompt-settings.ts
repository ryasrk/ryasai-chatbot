export interface PromptSettings {
  systemPrompt: string
  // ponytail: org-wide RAG context prompt — prepended to every RAG answer
  // synthesis (buildSourceGuidance in source-guidance.ts). Empty → injects
  // nothing, so the field must default to '' for existing orgs whose stored
  // JSON predates the key (backward-compat fill in parsePromptSettings).
  ragContextPrompt: string
  /**
   * Text-to-SQL rules — the numbered list sent as the RULES message to `generateSql`.
   *
   * WHY EDITABLE rather than living in code: these rules are DOMAIN knowledge, not engine behaviour.
   * They encode things like which columns to quote, that `IsDeleted` should be ignored unless asked,
   * and how to cast dates. Every customer's schema makes a different set of them wrong, and the
   * failure is GRADED — a bad rule yields a query that runs and returns the wrong rows, not an error.
   *
   * SAFETY IS UNCHANGED BY EDITING THIS. The rules are prose guidance to the model; enforcement lives
   * in `guardrails.ts` (SELECT-only, mutation keywords, side-effecting functions) and again at the
   * execution boundary in `real-connectors.ts`. An operator can make the SQL smarter or dumber by
   * editing text, but cannot make it destructive.
   *
   * Empty → the built-in default is used, so an org that never opens the editor behaves exactly as
   * before the field existed.
   */
  sqlRulesPrompt: string
  tools: { rag: boolean; sql: boolean; restApi: boolean }
}

const DEFAULTS: PromptSettings = {
  systemPrompt: '',
  ragContextPrompt: '',
  sqlRulesPrompt: '',
  tools: { rag: true, sql: true, restApi: true },
}

/**
 * Safely parse the `promptSettings` JSON column. Never throws — returns
 * defaults for null/undefined/garbage and fills missing keys so partial writes
 * (e.g. only `tools.sql`) don't wipe the rest.
 */
export function parsePromptSettings(json: string | null | undefined): PromptSettings {
  if (!json) return structuredClone(DEFAULTS)
  try {
    const raw = JSON.parse(json) as Partial<PromptSettings>
    return {
      systemPrompt: typeof raw.systemPrompt === 'string' ? raw.systemPrompt : '',
      // Backward-compat: old JSON without this key must resolve to '' so a
      // missing key never injects `undefined`-as-string into a RAG prompt.
      ragContextPrompt: typeof raw.ragContextPrompt === 'string' ? raw.ragContextPrompt : '',
      // Same backward-compat rule: '' means "use the built-in default", which is what every org
      // stored before this key existed must get.
      sqlRulesPrompt: typeof raw.sqlRulesPrompt === 'string' ? raw.sqlRulesPrompt : '',
      tools: {
        rag: raw.tools?.rag ?? true,
        sql: raw.tools?.sql ?? true,
        restApi: raw.tools?.restApi ?? true,
      },
    }
  } catch {
    return structuredClone(DEFAULTS)
  }
}

/**
 * Merge a partial update over the current settings. Unknown/invalid types are
 * ignored so a bad PUT body can't corrupt the column.
 */
export function mergePromptSettings(
  current: PromptSettings,
  update: {
    systemPrompt?: unknown
    ragContextPrompt?: unknown
    sqlRulesPrompt?: unknown
    tools?: Partial<PromptSettings['tools']>
  },
): PromptSettings {
  return {
    systemPrompt:
      typeof update.systemPrompt === 'string' ? update.systemPrompt : current.systemPrompt,
    // String-only — a non-string (e.g. number/null from a bad body) is ignored
    // rather than stringified, so only deliberate text updates land here.
    ragContextPrompt:
      typeof update.ragContextPrompt === 'string' ? update.ragContextPrompt : current.ragContextPrompt,
    sqlRulesPrompt:
      typeof update.sqlRulesPrompt === 'string' ? update.sqlRulesPrompt : current.sqlRulesPrompt,
    tools: {
      rag: typeof update.tools?.rag === 'boolean' ? update.tools.rag : current.tools.rag,
      sql: typeof update.tools?.sql === 'boolean' ? update.tools.sql : current.tools.sql,
      restApi:
        typeof update.tools?.restApi === 'boolean' ? update.tools.restApi : current.tools.restApi,
    },
  }
}

// ponytail: accept the tenant-extended db (not plain PrismaClient) so callers
// can pass the $extends client without a cast.
export async function getPromptSettings(
  db: typeof import('@/lib/db').db,
): Promise<PromptSettings> {
  const cfg = await db.appConfig.findFirst()
  return parsePromptSettings(cfg?.promptSettings)
}

/**
 * The built-in Text-to-SQL rules — the DEFAULT for `sqlRulesPrompt`.
 *
 * SINGLE SOURCE. This text used to be an inline concatenation inside `generateSql`, which made it
 * impossible to change without a deployment. It now backs the editor in Prompt & Tools, so an
 * operator can adapt it to their own schema, and `generateSql` falls back to it whenever the org has
 * not written its own.
 *
 * WHAT IT MAY CONTAIN: prose only. `{` and `}` are literal here — nothing interpolates into this
 * string — so do not add template placeholders expecting them to be filled. The dynamic parts of the
 * SQL prompt (schema description, user question, memory, repair feedback) are appended separately in
 * `generateSql`, because they change per request.
 *
 * EDITING IT CANNOT WEAKEN SAFETY. Enforcement lives in `guardrails.ts` (SELECT-only, mutation
 * keywords, side-effecting functions) and again at the execution boundary in `real-connectors.ts`.
 * These rules only guide the model; rule 1 states the limit for the model's benefit, it does not
 * implement it.
 *
 * RULES 13-16 encode bugs that were fixed once and must not be dropped in a rewrite:
 *   13  case-insensitive search per dialect (bare `=` misses real data)
 *   14  explicit ESCAPE for % and _ in a search term
 *   15  NULL semantics (never `= NULL`)
 *   16  substring for "contains"-style wording vs exact for "exactly"
 * `ai.test.ts` asserts on this text — extend those assertions rather than deleting them.
 */
export const DEFAULT_SQL_RULES_PROMPT = `1. ONLY SELECT is allowed. INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE are FORBIDDEN.
2. Always include LIMIT when relevant (maximum 100 rows).
3. Use only tables & columns that exist in the following schema.
4. Format your answer as JSON: {"sql": "...", "explanation": "..."}.
5. Do not wrap with markdown code fence.
6. When filtering by date, always cast string literals to the column type, e.g. WHERE order_date >= DATE '2026-07-30' or WHERE order_date::date = CURRENT_DATE. Never compare a date column directly to a bare string literal.
7. "hari ini" / "today" means CURRENT_DATE. "kemarin" / "yesterday" means CURRENT_DATE - 1.
8. If the question mentions a date but does not specify one, use CURRENT_DATE.
9. IMPORTANT: Always double-quote table and column names to preserve case sensitivity. For example, use "SELECT COUNT(*) FROM "participants" WHERE "IsDeleted" = false" NOT "SELECT COUNT(*) FROM participants WHERE IsDeleted = false". PostgreSQL lowercases unquoted identifiers, which causes "column does not exist" errors when the actual column name has uppercase letters.
10. Do NOT filter by "IsDeleted" or "DeletedAt" unless the user asks about deleted records. Most count queries should count ALL rows (active + deleted) unless the user specifically asks for "active" or "non-deleted" records.
11. When asked for a TOTAL count, use SELECT COUNT(*) FROM "table" — do NOT add WHERE clauses unless the user specifies a filter.
12. Use the BUSINESS CONTEXT (if provided) to identify the correct table for domain terms. If the business context maps a domain term to a specific table, use that table.
13. String search is case-sensitive with =, LIKE, and IN — user data rarely is. When searching text (names, titles, statuses, keywords), always match case-insensitively: PostgreSQL: "name" ILIKE '%john%' (or LOWER("name") = LOWER('John')); MySQL: LOWER(name) LIKE '%john%'; MSSQL: LOWER(name) LIKE '%john%'; ClickHouse: positionCaseInsensitive(name, 'john') > 0. Never use bare = or case-sensitive LIKE for user-facing text search.
14. If the search term itself can contain % or _ (e.g. searching for "50% off"), escape the wildcards with an explicit ESCAPE clause (e.g. ... ILIKE '%50^% off%' ESCAPE '^'). Do not strip user-supplied wildcards silently — the user may intend them as wildcards.
15. NULL semantics: comparisons with NULL yield NULL (never true). Use IS NULL / IS NOT NULL for null checks, never = NULL. Use COALESCE(col, default) when comparing a nullable column for equality. LIKE/ILIKE on a NULL column returns NULL — add OR col IS NULL only if the user explicitly wants missing values included.
16. Prefer substring matches over exact matches when the user says "contains", "about", "menyebut", "terkait", "tentang", or provides a partial value; use exact case-insensitive equality (= with LOWER, or ILIKE without %) for "exactly", "persis", full identifiers.
17. STATE THE POPULATION YOU MEASURED. MEASURED IN UAT: "Siapa 5 pelanggan dengan pembelian terbesar?" was answered from WHERE status = 'selesai', and the very next question in the SAME session used WHERE status <> 'dibatalkan', so two questions about the same customers reported different totals (Rp 1.240.000 vs Rp 1.620.000 for one customer) with the filter stated NOWHERE. The 3rd-largest customer was absent entirely. An analyst writes those numbers into a report and never learns which orders were included. So: if your query filters on status, a date range, a flag or any subset, the explanation field MUST name it in plain language — "berdasarkan pesanan berstatus selesai", "termasuk semua status", "hanya data 2026". Do NOT silently exclude rows. If the user's wording is ambiguous about which rows they mean, DO NOT choose silently: include everything and say so, or say which subset you used and why.
18. COUNT ROWS HONESTLY when a LIMIT applies. MEASURED IN UAT: a 126-row cross join was truncated to 100, and the answer reported the total as "105 baris" — a number INFERRED from the last row it could see, so 26 rows vanished behind a fabricated denominator. Never derive a total from truncated output. Report only what the query returned, or run a separate COUNT(*) and state that it is the true total.`

/**
 * Resolve the rules to send for this org.
 *
 * Returns the org's text when it has written one, otherwise the built-in default. Whitespace-only
 * input counts as empty: a field containing a stray newline must not silently replace the rules with
 * nothing, which would send a Text-to-SQL prompt with no rules at all and fail in a way that looks
 * like a model problem.
 */
export function resolveSqlRulesPrompt(configured: string | null | undefined): string {
  const trimmed = typeof configured === 'string' ? configured.trim() : ''
  return trimmed.length > 0 ? (configured as string) : DEFAULT_SQL_RULES_PROMPT
}

/**
 * Alias kept for `generateSql`'s fallback. Named separately from the constant so the call site reads
 * as "the default rules" rather than as a bare constant, and so a future change (e.g. a per-dialect
 * default) has an obvious place to live without touching every caller.
 */
export function defaultSqlRulesPrompt(): string {
  return DEFAULT_SQL_RULES_PROMPT
}
