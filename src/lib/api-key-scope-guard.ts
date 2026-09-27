import { db } from '@/lib/db'
import { describeScope, type KeyScope } from '@/lib/api-key-scope'

/**
 * Validate that every source an API key is scoped to still EXISTS and is USABLE.
 *
 * DECISION: FAIL CLOSED. If a key names a source that has been deleted, deactivated, or has fallen
 * into an error state, requests made with that key are REFUSED — they are not silently answered from
 * the remaining sources.
 *
 * WHY, given the friendlier alternative. "Just drop the missing source and answer from the rest" is
 * the same silent-narrowing mistake that `resolveScope` already refuses for an explicit request, one
 * level up. A client whose key was scoped to the ERP asking "what are Q3 sales?" would receive an
 * answer synthesised from policy documents, with citations that look legitimate. Nobody sees an
 * error, the answer is wrong, and the operator has no signal that their key scope is broken.
 *
 * The cost of failing closed is an explicit error naming the missing source, which is exactly the
 * information an admin needs to fix the key. An out-of-date scope is a configuration fault, and a
 * configuration fault that reports itself is cheaper than one that hides.
 *
 * WHY A SEPARATE PASS RATHER THAN A JOIN. The scope lists are ids; whether each is still usable lives
 * in three different tables with three different notions of "usable" (`Integration.status`,
 * `Document.status` + `isEnabled`, `RestApiConnector.isActive`). Resolving them here keeps that
 * knowledge in one place instead of spreading it across the transports that consume the scope.
 */

export class ScopeSourceMissingError extends Error {
  readonly code = 'SCOPE_SOURCE_MISSING'
  constructor(message: string) {
    super(message)
    this.name = 'ScopeSourceMissingError'
  }
}

/**
 * At most this many ids are resolved in ONE query batch; longer scope lists are batched.
 *
 * This was a hard `.slice(0, MAX_SCOPE_IDS)`, which is not a bound on query size but a bound on
 * VALIDATION: the 501st id on a key was never resolved, so a source that had been deleted was
 * reported as present and the key kept working against a scope the operator believed was checked.
 * The cap is a batching constant, so the fix is to batch rather than to truncate.
 */
const MAX_SCOPE_IDS = 500

/** Split an id list into query-sized batches, preserving order for stable error messages. */
function batch<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Check a key's scope against the database and throw when any named source is unusable.
 *
 * Returns the list of problems instead of throwing when `dryRun` is set, so the admin UI can warn an
 * operator BEFORE saving a scope that would immediately break — a key that cannot be used is worse
 * than one that is refused at creation.
 */
export async function validateKeyScopeSources(
  scope: KeyScope,
  opts: { dryRun?: boolean } = {},
): Promise<string[]> {
  const problems: string[] = []

  // An UNREADABLE scope is reported as a problem here, which is what closes the create-time hole.
  //
  // The admin POST resolves the submitted body through `readKeyScope` and then persists
  // `scope.allowedDocumentIds` / `scope.allowedTools` verbatim. For a malformed submission those are
  // `[]` — and `[]` means UNRESTRICTED — so an operator who submitted `allowedDocumentIds: "doc-1"`
  // (one document intended) got a key that could read EVERY document, with a success response and no
  // warning. MEASURED before this check: the route persisted `{"allowedDocumentIds":[],"allowedTools":[]}`.
  //
  // This function is already the pre-save gate (`describeScopeProblems`), so reporting the unreadable
  // fields HERE refuses the create with a form message instead of minting a wider key than requested.
  // The runtime path reports the same fields, so a row that is already in the table still fails closed.
  if (scope.malformed && scope.malformed.length > 0) {
    problems.push(`scope is unreadable: ${scope.malformed.join('; ')}`)
  }

  const integrationIds = scope.allowedIntegrationIds
  const documentIds = scope.allowedDocumentIds

  if (integrationIds.length > 0) {
    // Integrations and REST connectors share the scope field but live in separate tables, so both
    // are resolved and a name counts as present in EITHER. Looking only at `Integration` would
    // report every REST-scoped key as broken.
    const integrations: Array<{ id: string; name: string; status: string }> = []
    const connectors: Array<{ id: string; name: string; isActive: boolean }> = []
    for (const ids of batch(integrationIds, MAX_SCOPE_IDS)) {
      const [i, c] = await Promise.all([
        db.integration.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, status: true },
        }),
        db.restApiConnector.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, isActive: true },
        }),
      ])
      integrations.push(...i)
      connectors.push(...c)
    }

    const usable = new Set<string>()
    for (const i of integrations) {
      // `status` is a string column with `active | inactive | error`. Only `active` is usable: an
      // integration in `error` state would fail the request anyway, and failing HERE says why.
      if (i.status === 'active') usable.add(i.id)
    }
    for (const c of connectors) {
      if (c.isActive) usable.add(c.id)
    }

    const missing = integrationIds.filter((id) => !usable.has(id))
    if (missing.length > 0) {
      // Report a NAME where one is known, an id otherwise. An operator acts on names, but a
      // dangling id that resolves to nothing can only be reported as itself.
      const nameById = new Map<string, string>()
      for (const r of [...integrations, ...connectors]) nameById.set(r.id, r.name)
      const labels = missing.map((id) => nameById.get(id) ?? id)
      problems.push(
        `${labels.length === 1 ? 'Source' : 'Sources'} no longer available: ${labels.join(', ')}`,
      )
    }
  }

  if (documentIds.length > 0) {
    const docs: Array<{ id: string; name: string; status: string; isEnabled: boolean }> = []
    for (const ids of batch(documentIds, MAX_SCOPE_IDS)) {
      docs.push(
        ...(await db.document.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, status: true, isEnabled: true },
        })),
      )
    }
    const usable = new Set(docs.filter((d) => d.status === 'ready' && d.isEnabled).map((d) => d.id))
    const missing = documentIds.filter((id) => !usable.has(id))
    if (missing.length > 0) {
      // Index by id once. A `docs.find(...)` per missing id is O(n*m), which a large scope makes
      // expensive on a path that runs on every request; the labels are identical either way.
      const nameById = new Map(docs.map((d) => [d.id, d.name]))
      const labels = missing.map((id) => nameById.get(id) ?? id)
      problems.push(
        `${labels.length === 1 ? 'Document' : 'Documents'} no longer available: ${labels.join(', ')}`,
      )
    }
  }

  if (problems.length > 0 && !opts.dryRun) {
    throw new ScopeSourceMissingError(
      `This API key is scoped to sources that no longer exist or are not usable. ${problems.join('; ')}. ` +
        `Ask an administrator to update the key's scope.`,
    )
  }

  return problems
}

/** Convenience for the admin UI: does this scope resolve cleanly right now? */
export async function describeScopeProblems(scope: KeyScope): Promise<string | null> {
  const problems = await validateKeyScopeSources(scope, { dryRun: true })
  if (problems.length === 0) return null
  // The scope's own description is useful context for a MISSING-SOURCE problem ("which key is this?"),
  // but for an UNREADABLE one it repeats the field list already in `problems` — `describeScope` renders
  // a malformed scope as "Unreadable scope", so appending it there says the same thing twice.
  if (scope.malformed && scope.malformed.length > 0) return problems.join('; ')
  return `${problems.join('; ')} — ${describeScope(scope)}`
}
