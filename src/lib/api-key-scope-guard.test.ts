import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { readKeyScope } from './api-key-scope'

/**
 * Fail-closed source validation (decision A).
 *
 * A key scoped to a source that no longer exists or is no longer usable must REFUSE requests, not
 * answer from whatever remains. The alternative — silently narrowing — produces a confident answer
 * built from sources the operator did not choose, which is the failure mode `resolveScope` already
 * refuses one level up.
 */
const state = {
  integrations: [] as Array<{ id: string; name: string; status: string }>,
  connectors: [] as Array<{ id: string; name: string; isActive: boolean }>,
  documents: [] as Array<{ id: string; name: string; status: string; isEnabled: boolean }>,
}

mock.module('@/lib/db', () => ({
  db: {
    integration: { findMany: async (a: { where: { id: { in: string[] } } }) => state.integrations.filter((i) => a.where.id.in.includes(i.id)) },
    restApiConnector: { findMany: async (a: { where: { id: { in: string[] } } }) => state.connectors.filter((c) => a.where.id.in.includes(c.id)) },
    document: { findMany: async (a: { where: { id: { in: string[] } } }) => state.documents.filter((d) => a.where.id.in.includes(d.id)) },
  },
}))

const { ScopeSourceMissingError, describeScopeProblems, validateKeyScopeSources } = await import(
  './api-key-scope-guard'
)

beforeEach(() => {
  state.integrations = []
  state.connectors = []
  state.documents = []
})

describe('scope source validation — an unrestricted key is never checked or refused', () => {
  test('an empty scope passes without querying anything', async () => {
    // THE load-bearing case for "empty means all": every key created before this feature has empty
    // arrays. If validation treated empty as "resolve nothing", every existing key would start
    // failing the moment this shipped.
    const problems = await validateKeyScopeSources(readKeyScope({}), { dryRun: true })
    expect(problems).toEqual([])
    // And it must not throw on the enforcing path either.
    await expect(validateKeyScopeSources(readKeyScope({}))).resolves.toEqual([])
  })
})

describe('scope source validation — usable sources pass', () => {
  test('an active integration is accepted', async () => {
    state.integrations = [{ id: 'erp', name: 'ERP', status: 'active' }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['erp'] })),
    ).resolves.toEqual([])
  })

  test('a ready and enabled document is accepted', async () => {
    state.documents = [{ id: 'd1', name: 'SOP.pdf', status: 'ready', isEnabled: true }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedDocumentIds: ['d1'] })),
    ).resolves.toEqual([])
  })

  test('an ACTIVE REST connector counts, even though it is not an Integration row', async () => {
    // Both live in the same scope array but in different tables. Resolving only `Integration` would
    // report every REST-scoped key as broken, which would be a self-inflicted outage.
    state.connectors = [{ id: 'rest-1', name: 'CRM API', isActive: true }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['rest-1'] })),
    ).resolves.toEqual([])
  })
})

describe('scope source validation — unusable sources REFUSE the request', () => {
  test('a deleted integration throws, and names it', async () => {
    expect.assertions(2)
    try {
      await validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['gone'] }))
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeSourceMissingError)
      // The message must name the source: "scope is broken" with no name gives an operator nothing.
      expect((e as Error).message).toContain('gone')
    }
  })

  test('an INACTIVE integration throws even though the row still exists', async () => {
    // Existence is not usability. A row in `error` state would fail the request anyway — failing
    // here instead says WHY, which is the whole justification for failing closed.
    state.integrations = [{ id: 'erp', name: 'ERP', status: 'error' }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['erp'] })),
    ).rejects.toBeInstanceOf(ScopeSourceMissingError)
  })

  test('an inactive REST connector throws', async () => {
    state.connectors = [{ id: 'rest-1', name: 'CRM API', isActive: false }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['rest-1'] })),
    ).rejects.toBeInstanceOf(ScopeSourceMissingError)
  })

  test('a document that is ready but DISABLED throws', async () => {
    state.documents = [{ id: 'd1', name: 'SOP.pdf', status: 'ready', isEnabled: false }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedDocumentIds: ['d1'] })),
    ).rejects.toBeInstanceOf(ScopeSourceMissingError)
  })

  test('a document still PROCESSING throws', async () => {
    // Not yet searchable. Accepting it would answer from an empty candidate set and look like a
    // retrieval miss rather than a configuration problem.
    state.documents = [{ id: 'd1', name: 'New.pdf', status: 'processing', isEnabled: true }]
    await expect(
      validateKeyScopeSources(readKeyScope({ allowedDocumentIds: ['d1'] })),
    ).rejects.toBeInstanceOf(ScopeSourceMissingError)
  })

  test('ONE missing source among several valid ones still refuses', async () => {
    // The crux of decision A: answering from the remaining sources is exactly the silent narrowing
    // this refuses. The request fails so the operator learns the scope is stale.
    state.integrations = [{ id: 'erp', name: 'ERP', status: 'active' }]
    state.documents = [{ id: 'd1', name: 'SOP.pdf', status: 'ready', isEnabled: true }]
    const scope = readKeyScope({
      allowedIntegrationIds: ['erp', 'removed-db'],
      allowedDocumentIds: ['d1'],
    })
    try {
      await validateKeyScopeSources(scope)
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeSourceMissingError)
      expect((e as Error).message).toContain('removed-db')
      // The VALID source must not be reported as a problem.
      expect((e as Error).message).not.toContain('ERP')
    }
  })

  test('the error names the source by NAME when the row still exists', async () => {
    state.integrations = [{ id: 'erp', name: 'ERP Production', status: 'inactive' }]
    try {
      await validateKeyScopeSources(readKeyScope({ allowedIntegrationIds: ['erp'] }))
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('ERP Production')
    }
  })

  test('both categories can be reported in one error', async () => {
    const scope = readKeyScope({ allowedIntegrationIds: ['gone-1'], allowedDocumentIds: ['gone-2'] })
    try {
      await validateKeyScopeSources(scope)
      throw new Error('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('gone-1')
      expect(msg).toContain('gone-2')
      // Tells the operator what to DO, not just what is wrong.
      expect(msg).toMatch(/administrator/i)
    }
  })
})

describe('scope source validation — dry run for the admin UI', () => {
  test('dryRun reports problems without throwing, so a bad scope can be blocked before saving', async () => {
    const problems = await validateKeyScopeSources(
      readKeyScope({ allowedIntegrationIds: ['gone'] }),
      { dryRun: true },
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('gone')
  })

  test('describeScopeProblems returns null when the scope resolves', async () => {
    state.integrations = [{ id: 'erp', name: 'ERP', status: 'active' }]
    expect(await describeScopeProblems(readKeyScope({ allowedIntegrationIds: ['erp'] }))).toBeNull()
  })
})

/**
 * The id cap is a QUERY-BATCHING bound, not a validation bound.
 *
 * `validateKeyScopeSources` used to resolve `scope.allowedDocumentIds.slice(0, 500)`, so the 501st id
 * was never looked up: a document deleted from a large scope was reported as present, the request was
 * allowed through, and the operator's key silently kept a dead source. That is this module's own
 * fail-closed promise (see the header) broken by an unrelated-looking constant — and it is invisible
 * at any realistic size, because 500 ids is when it starts.
 */
describe('scope source validation — a scope larger than one query batch is still fully validated', () => {
  test('a missing document at index 500 is FOUND, not skipped by the cap', async () => {
    // 500 valid ids + one deleted id past the old slice boundary.
    const ids = Array.from({ length: 500 }, (_, i) => `ok-${i}`)
    state.documents = ids.map((id) => ({ id, name: id, status: 'ready', isEnabled: true }))
    const scope = readKeyScope({ allowedDocumentIds: [...ids, 'deleted-past-the-cap'] })

    // Every id must reach the database. The mock filters by `where.id.in`, so an id that was sliced
    // off is simply never queried and cannot be reported missing.
    await expect(validateKeyScopeSources(scope, { dryRun: true })).resolves.toEqual([
      'Document no longer available: deleted-past-the-cap',
    ])
  })

  test('a missing INTEGRATION past the cap is found too', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => `ok-${i}`)
    state.integrations = ids.map((id) => ({ id, name: id, status: 'active' }))
    const scope = readKeyScope({ allowedIntegrationIds: [...ids, 'gone-past-the-cap'] })
    await expect(validateKeyScopeSources(scope, { dryRun: true })).resolves.toEqual([
      'Source no longer available: gone-past-the-cap',
    ])
  })

  test('batching must not LOSE work: 501 valid ids all resolve clean', async () => {
    // Guards the wrong fix that drops the cap for one enormous `IN`. Asserted on the observable
    // outcome rather than a call count: an id in the SECOND batch is not misreported as missing, so
    // batching cannot turn a valid source into a spurious failure.
    const ids = Array.from({ length: 501 }, (_, i) => `ok-${i}`)
    state.documents = ids.map((id) => ({ id, name: id, status: 'ready', isEnabled: true }))
    const scope = readKeyScope({ allowedDocumentIds: ids })
    await expect(validateKeyScopeSources(scope)).resolves.toEqual([])
  })
})

/**
 * The admin UI's pre-save gate must also refuse a scope that could not be READ.
 *
 * `readKeyScope` resolves a malformed submission (e.g. `allowedDocumentIds: "doc-1"`) to `[]`, and the
 * create route persists those arrays verbatim. `[]` means UNRESTRICTED in this module, so without the
 * check below an operator who asked for ONE document receives a 201 and a key that can read EVERY
 * document — a wider grant than requested, with no warning anywhere.
 *
 * MEASURED before the check: the create path persisted `{"allowedDocumentIds":[],"allowedTools":[]}`
 * for exactly that input.
 */
describe('scope source validation — an unreadable scope is refused before it is saved', () => {
  test('a malformed submission yields a problem, so the POST refuses instead of widening the key', async () => {
    const scope = readKeyScope({ allowedDocumentIds: 'doc-1', allowedTools: ['rag'] })
    const problem = await describeScopeProblems(scope)
    expect(problem).not.toBeNull()
    expect(problem).toContain('unreadable')
    // The message must name the offending field, or an operator cannot fix the form.
    expect(problem).toContain('allowedDocumentIds')
  })

  test('a legitimately unrestricted key is still accepted — this must not become a blanket refusal', async () => {
    // The opposite error: treating every EMPTY scope as a fault would break the create path for the
    // common "all sources" key, which is the default and the value every pre-feature key holds.
    expect(await describeScopeProblems(readKeyScope({}))).toBeNull()
    expect(await describeScopeProblems(readKeyScope({ allowedDocumentIds: [], allowedTools: [] }))).toBeNull()
  })

  test('enforcement refuses the same scope the create gate refuses', async () => {
    // Both layers must agree: a row that reached the table by any other route (seed, migration, direct
    // SQL) still fails closed at request time.
    const scope = readKeyScope({ allowedDocumentIds: 'doc-1' })
    await expect(validateKeyScopeSources(scope)).rejects.toBeInstanceOf(ScopeSourceMissingError)
  })
})
