/**
 * API key source scoping — which sources a key may read, and what a request may narrow to.
 *
 * WHY THIS MODULE EXISTS. Before it, one API key granted access to EVERY source in the org: the
 * `ApiKey` model had no scope fields at all, and `requireExternalApiKey` returned only
 * `{ apiKeyId, organizationId, label }`. There was no way to hand a client a key limited to one
 * database or one document set, which is a business limitation rather than a missing convenience —
 * customers share a chatbot with partners and contractors, and "you see everything" is not a
 * starting point they can negotiate from.
 *
 * WHY THE RULES LIVE HERE AND NOT AT EACH CALL SITE. Enforcement that is copied into the SQL branch
 * and the RAG branch and the REST branch is enforcement that will disagree: one branch gets a fix,
 * the others keep the hole, and the difference is invisible until someone exploits it. This module
 * answers one question — "what may this request read?" — and every transport asks it.
 *
 * EMPTY MEANS ALL. `allowedIntegrationIds: []` is NOT "nothing allowed"; it is "unrestricted", which
 * is what every key created before this feature must keep doing. The opposite convention would have
 * silently revoked access for every existing integration on deploy. That choice is load-bearing and
 * is asserted by tests in both directions, because inverting it is a one-character change.
 */

/** Tool families a key can be limited to. Mirrors the router's own decision values. */
export const API_KEY_TOOLS = ['SQL', 'RAG', 'REST', 'CHAT'] as const
export type ApiKeyTool = (typeof API_KEY_TOOLS)[number]

export function isApiKeyTool(value: unknown): value is ApiKeyTool {
  return typeof value === 'string' && (API_KEY_TOOLS as readonly string[]).includes(value)
}

/** The scope stored on a key row. Empty arrays mean "unrestricted". */
export interface KeyScope {
  allowedIntegrationIds: string[]
  allowedDocumentIds: string[]
  /** Validated tool families. `readKeyScope` filters unknown names out, so these are real values. */
  allowedTools: ApiKeyTool[]
  /**
   * Stored fields that could NOT be read unambiguously, e.g. `allowedDocumentIds` holding
   * `"doc-1"` instead of `["doc-1"]`, or `allowedTools` holding only unrecognised names.
   *
   * WHY A FIELD AND NOT AN EXCEPTION: `readKeyScope` is also called by the admin panel to RENDER a
   * key's scope, where throwing would blank the whole list. Recording the problem here keeps the
   * reader total (display stays up) while `resolveScope` — the enforcement path — refuses a scope
   * that is present but unreadable.
   *
   * WHY IT MUST REFUSE RATHER THAN DEFAULT: an unreadable field arrives as `[]`, and `[]` means
   * UNRESTRICTED in this module. So a malformed value would silently WIDEN the key from "one document"
   * to "every document in the org". Absent (`[]`) and unreadable (this field) are different facts and
   * must not resolve to the same answer.
   */
  malformed?: string[]
}

/**
 * Thrown when a stored scope cannot be read UNAMBIGUOUSLY.
 *
 * Distinct from `ScopeDeniedError`: that one means "the request asked for something the key does not
 * allow" (client-actionable), while this one means "the key's own record is unreadable"
 * (administrator-actionable). Both fail closed.
 */
export class ScopeConfigError extends Error {
  readonly code = 'SCOPE_CONFIG_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'ScopeConfigError'
  }
}

/** What a single request asked for. Absent fields mean "whatever the key allows". */
export interface RequestedScope {
  integrationIds?: string[]
  documentIds?: string[]
}

/** The resolved answer, handed to the retrieval and routing code. */
export interface EffectiveScope {
  /** `null` = every integration. A list = only these. */
  integrationIds: string[] | null
  /** `null` = every document. A list = only these. */
  documentIds: string[] | null
  /** `null` = every tool. A list = only these. */
  tools: ApiKeyTool[] | null
}

/** Thrown when a request asks for a source the key is not allowed to read. */
export class ScopeDeniedError extends Error {
  readonly code = 'SCOPE_DENIED'
  constructor(message: string) {
    super(message)
    this.name = 'ScopeDeniedError'
  }
}

/** Normalize a raw column value: dedupe, drop blanks, keep order stable for readable errors. */
function cleanIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const v of raw) {
    if (typeof v === 'string' && v.trim()) seen.add(v.trim())
  }
  return [...seen]
}

/**
 * Read an id-list column, reporting (not throwing on) a present value that is not a list.
 *
 * `cleanIds` cannot distinguish "column absent (a pre-migration row or a test double)" from
 * "column present but wrong type", and both resolved to `[]` — which this module reads as
 * UNRESTRICTED. So a stored `allowedDocumentIds: "doc-1"` (a bare string) silently widened the key
 * from one document to every document in the org. That is the empty-means-all convention failing in
 * the unsafe direction, so the two cases must not resolve to the same value:
 *
 *   * absent / null  -> `[]` + no problem = unrestricted. Load-bearing: every key created before this
 *                       feature has empty arrays, and treating that as a fault would break all of them.
 *   * present, not a list -> `[]` + PROBLEM. There is no reading of `"doc-1"` the operator intended,
 *                       and both available guesses ("all" / "just doc-1") are guesses. The caller
 *                       decides: display must not throw, enforcement must not default.
 *
 * An array containing only blanks is treated as absent for the same reason it always was: `['']` is
 * what a form submits when no checkbox is ticked.
 */
function readIdList(raw: unknown, field: string, problems: string[]): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    problems.push(`${field} is not a list (received ${typeof raw})`)
    return []
  }
  return cleanIds(raw)
}

/**
 * Read a key's scope off a row.
 *
 * Tolerates `null`/`undefined` for the array columns so a row loaded before the migration (or a
 * hand-written test double) resolves to "unrestricted" rather than throwing — a missing column must
 * not become a runtime failure in the auth path.
 *
 * A present-but-mistyped or unrecognised column is recorded in `malformed` instead; `resolveScope`
 * refuses such a scope. The reader itself stays total so the admin list still renders.
 */
export function readKeyScope(row: {
  allowedIntegrationIds?: unknown
  allowedDocumentIds?: unknown
  allowedTools?: unknown
}): KeyScope {
  const problems: string[] = []
  const rawIntegrationIds = readIdList(row.allowedIntegrationIds, 'allowedIntegrationIds', problems)
  const rawDocumentIds = readIdList(row.allowedDocumentIds, 'allowedDocumentIds', problems)
  const rawTools = readIdList(row.allowedTools, 'allowedTools', problems)
  const allowedTools = rawTools.filter(isApiKeyTool)
  // A tool name this build does not know is dropped, which is correct for a FORWARD-compatible read
  // (a newer version may have written it) but wrong to treat as "no restriction at all": dropping the
  // only entry left `[]`, which resolves to ALL TOOLS. So a list that HAD entries and lost every one
  // of them because none was recognised is a misconfiguration, not an unrestricted key. `['rag']`
  // (case error) and `['SQLX']` (typo) are the realistic shapes of this.
  if (rawTools.length > 0 && allowedTools.length === 0) {
    problems.push(
      `allowedTools contains no recognised tool name ` +
        `(${rawTools.map((t) => JSON.stringify(t)).join(', ')}; valid values are ${API_KEY_TOOLS.join(', ')})`,
    )
  }
  return {
    allowedIntegrationIds: rawIntegrationIds,
    allowedDocumentIds: rawDocumentIds,
    allowedTools: [...new Set(allowedTools)],
    ...(problems.length > 0 ? { malformed: problems } : {}),
  }
}

/**
 * Intersect the key's scope with what the request asked for.
 *
 * THE ASYMMETRY HERE IS DELIBERATE, and it is the whole point of the function:
 *
 *   * Request asks for NOTHING      -> the key's scope applies (possibly "all").
 *   * Request asks for something    -> it must be a SUBSET of the key's scope.
 *
 * A request that asks for a source outside the key's scope is REJECTED, never silently narrowed.
 * Narrowing would be the friendlier-looking choice and the more dangerous one: a client asking
 * "what are Q3 sales in the ERP?" would be answered from documents instead, producing a confident
 * answer to a question nobody asked. This codebase has paid for that failure mode repeatedly — a
 * silent fallback that reports success for work it did not do.
 *
 * An unrestricted key (empty array) accepts any subset, so a client of such a key can only narrow
 * its OWN access, never exceed it.
 */
export function resolveScope(
  key: KeyScope,
  requested: RequestedScope = {},
): EffectiveScope {
  // FAIL CLOSED ON AN UNREADABLE RECORD, before any intersection. An unreadable field arrives as an
  // empty array, and empty means UNRESTRICTED here, so proceeding would answer with every source in
  // the org — strictly more than the operator configured. This is the one place where "the row is
  // wrong" must not be resolved by a default.
  if (key.malformed && key.malformed.length > 0) {
    throw new ScopeConfigError(
      `This API key's stored scope is unreadable: ${key.malformed.join('; ')}. ` +
        `Requests are refused rather than answered with every source in the organization. ` +
        `Ask an administrator to re-save the key's scope.`,
    )
  }

  const allowedIntegrations = key.allowedIntegrationIds.length > 0 ? key.allowedIntegrationIds : null
  const allowedDocuments = key.allowedDocumentIds.length > 0 ? key.allowedDocumentIds : null
  const allowedTools = key.allowedTools.length > 0 ? key.allowedTools : null

  const reqIntegrations = cleanIds(requested.integrationIds)
  const reqDocuments = cleanIds(requested.documentIds)

  if (allowedIntegrations !== null) {
    const denied = reqIntegrations.filter((id) => !allowedIntegrations.includes(id))
    if (denied.length > 0) {
      throw new ScopeDeniedError(
        `This API key is not allowed to read ${denied.length === 1 ? 'source' : 'sources'}: ` +
          `${denied.join(', ')}. Ask the administrator who issued the key.`,
      )
    }
  }

  if (allowedDocuments !== null) {
    const denied = reqDocuments.filter((id) => !allowedDocuments.includes(id))
    if (denied.length > 0) {
      throw new ScopeDeniedError(
        `This API key is not allowed to read ${denied.length === 1 ? 'document' : 'documents'}: ` +
          `${denied.join(', ')}. Ask the administrator who issued the key.`,
      )
    }
  }

  return {
    // A request that names sources narrows to exactly those; otherwise the key's list (or null).
    integrationIds: reqIntegrations.length > 0 ? reqIntegrations : allowedIntegrations,
    documentIds: reqDocuments.length > 0 ? reqDocuments : allowedDocuments,
    tools: allowedTools,
  }
}

/**
 * True when this scope may use a tool family. `null` tools means every family.
 *
 * ⚠ UNREACHABLE FROM PRODUCTION TODAY — a KNOWN OPEN DEFECT, recorded here because this is where the next
 * reader will look. Verified by grep: the only references are this definition and its test; nothing calls
 * it, and nothing reads `effectiveScope.tools` either (the route reads only `.documentIds`).
 *
 * CONSEQUENCE: a key created with `allowedTools: ['RAG']` is NOT refused when a question needs SQL. That
 * axis of the scope is stored, validated, displayed — and enforces nothing. `allowedIntegrationIds` is in
 * the same state: `effectiveScope.integrationIds` is computed and then dropped.
 *
 * The fix belongs in the TRANSPORT, not here. The route already resolves the scope before the pipeline
 * runs, so the router's decision must be checked against `effectiveScope.tools` and REFUSED (403) rather
 * than downgraded to CHAT — a silent downgrade would answer a data question conversationally, which is the
 * silently-narrowed answer this module refuses everywhere else.
 */
export function scopeAllowsTool(scope: EffectiveScope, tool: string): boolean {
  if (scope.tools === null) return true
  return scope.tools.includes(tool as ApiKeyTool)
}

/** Human-readable summary for the key list, so an operator can see scope without opening the key. */
export function describeScope(key: KeyScope): string {
  const parts: string[] = []
  if (key.allowedIntegrationIds.length > 0) {
    parts.push(`${key.allowedIntegrationIds.length} source${key.allowedIntegrationIds.length === 1 ? '' : 's'}`)
  }
  if (key.allowedDocumentIds.length > 0) {
    parts.push(`${key.allowedDocumentIds.length} document${key.allowedDocumentIds.length === 1 ? '' : 's'}`)
  }
  if (key.allowedTools.length > 0) parts.push(key.allowedTools.join('/'))
  // An unreadable scope must never render as "All sources": that is the single most misleading label
  // available for the one row where the stored value could not be interpreted, and the operator is
  // the only party who can fix it. Enforcement already refuses it (see `resolveScope`).
  if (key.malformed && key.malformed.length > 0) {
    return `Unreadable scope — fix required (${key.malformed.join('; ')})`
  }
  // Empty on every axis is "all", and saying so explicitly matters: a blank cell would read as
  // "no access configured" and an operator would either over- or under-trust it.
  return parts.length > 0 ? parts.join(' · ') : 'All sources'
}
