import { describe, expect, test } from 'bun:test'

import {
  API_KEY_TOOLS,
  describeScope,
  isApiKeyTool,
  readKeyScope,
  resolveScope,
  ScopeConfigError,
  scopeAllowsTool,
  ScopeDeniedError,
} from './api-key-scope'

/**
 * Source scoping semantics.
 *
 * The tests below pin BOTH directions of the empty-means-all convention. It is a one-character
 * change to invert, it would silently revoke every existing key's access on deploy, and the symptom
 * (a previously working integration returning "not allowed") looks like a client bug rather than a
 * server convention.
 */
describe('api key scope — reading a stored key', () => {
  test('absent or null columns resolve to unrestricted, not to denied', () => {
    // A row loaded before the migration, or a test double that omits the field, must not lock anyone
    // out. Throwing here would turn a missing column into an auth failure.
    for (const row of [{}, { allowedIntegrationIds: null, allowedDocumentIds: null, allowedTools: null }]) {
      const s = readKeyScope(row as never)
      expect(s.allowedIntegrationIds).toEqual([])
      expect(s.allowedDocumentIds).toEqual([])
      expect(s.allowedTools).toEqual([])
      expect(resolveScope(s)).toEqual({ integrationIds: null, documentIds: null, tools: null })
    }
  })

  test('blanks and duplicates are dropped, order preserved', () => {
    const s = readKeyScope({
      allowedIntegrationIds: ['b', 'a', 'b', '', '  '],
      allowedDocumentIds: ['d1', ' d1 '],
      allowedTools: ['RAG', 'RAG'],
    })
    expect(s.allowedIntegrationIds).toEqual(['b', 'a'])
    expect(s.allowedDocumentIds).toEqual(['d1'])
    expect(s.allowedTools).toEqual(['RAG'])
  })

  test('unknown tool names are discarded rather than stored', () => {
    // A typo must not become a tool nobody can use; it should simply not be granted.
    const s = readKeyScope({ allowedTools: ['RAG', 'EXECUTE_SHELL', 'sql'] })
    expect(s.allowedTools).toEqual(['RAG'])
    expect(API_KEY_TOOLS).toContain('SQL')
  })

  test('isApiKeyTool rejects non-strings and near-misses', () => {
    expect(isApiKeyTool('SQL')).toBe(true)
    expect(isApiKeyTool('sql')).toBe(false)
    expect(isApiKeyTool(null)).toBe(false)
    expect(isApiKeyTool(1)).toBe(false)
  })
})

describe('api key scope — resolving a request', () => {
  const restricted = readKeyScope({
    allowedIntegrationIds: ['erp', 'crm'],
    allowedDocumentIds: ['doc-1'],
    allowedTools: ['RAG', 'CHAT'],
  })

  test('an unrestricted key accepts any subset the client asks for', () => {
    // A client may narrow its OWN access; it can never exceed the key.
    const open = readKeyScope({})
    expect(resolveScope(open, { integrationIds: ['anything'] })).toEqual({
      integrationIds: ['anything'],
      documentIds: null,
      tools: null,
    })
  })

  test('a restricted key accepts a subset of what it allows', () => {
    const eff = resolveScope(restricted, { integrationIds: ['erp'], documentIds: ['doc-1'] })
    expect(eff.integrationIds).toEqual(['erp'])
    expect(eff.documentIds).toEqual(['doc-1'])
  })

  test('a request naming an allowed source keeps the REST of the key scope intact', () => {
    // Narrowing the integration must not widen documents: the tools list stays from the key.
    const eff = resolveScope(restricted, { integrationIds: ['erp'] })
    expect(eff.documentIds).toEqual(['doc-1'])
    expect(eff.tools).toEqual(['RAG', 'CHAT'])
  })

  test('a request OUTSIDE the scope is REJECTED, not silently narrowed', () => {
    // The load-bearing behaviour. Silently dropping "crm" would answer a question about CRM from
    // whatever else was allowed — a confident answer to a question nobody asked.
    expect(() => resolveScope(restricted, { integrationIds: ['crm', 'payroll'] })).toThrow(ScopeDeniedError)
    try {
      resolveScope(restricted, { integrationIds: ['payroll'] })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeDeniedError)
      // The message must name WHAT was refused, or an operator cannot act on it.
      expect((e as Error).message).toContain('payroll')
      expect((e as Error).message).toMatch(/not allowed/i)
    }
  })

  test('a denied document is rejected too, and names the document', () => {
    try {
      resolveScope(restricted, { documentIds: ['doc-999'] })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeDeniedError)
      expect((e as Error).message).toContain('doc-999')
    }
  })

  test('no request and no key restriction yields null on every axis', () => {
    expect(resolveScope(readKeyScope({}))).toEqual({
      integrationIds: null,
      documentIds: null,
      tools: null,
    })
  })

  test('an empty request leaves the key restriction in place', () => {
    expect(resolveScope(restricted)).toEqual({
      integrationIds: ['erp', 'crm'],
      documentIds: ['doc-1'],
      tools: ['RAG', 'CHAT'],
    })
  })
})

describe('api key scope — tool families', () => {
  test('null tools allows everything; a list allows only itself', () => {
    expect(scopeAllowsTool({ integrationIds: null, documentIds: null, tools: null }, 'SQL')).toBe(true)
    const ragOnly = { integrationIds: null, documentIds: null, tools: ['RAG' as const] }
    expect(scopeAllowsTool(ragOnly, 'RAG')).toBe(true)
    expect(scopeAllowsTool(ragOnly, 'SQL')).toBe(false)
    // Case matters: the router emits uppercase, so a lowercase entry grants nothing and that
    // mismatch must be visible rather than accidentally permissive.
    expect(scopeAllowsTool(ragOnly, 'rag')).toBe(false)
  })
})

describe('api key scope — describing it for the key list', () => {
  test('an unrestricted key says so explicitly', () => {
    // A blank cell would read as "no access configured" and be over- or under-trusted.
    expect(describeScope(readKeyScope({}))).toBe('All sources')
  })

  test('a restricted key counts what it allows and never prints ids', () => {
    const s = describeScope(readKeyScope({ allowedIntegrationIds: ['erp'], allowedDocumentIds: ['d1', 'd2'], allowedTools: ['RAG'] }))
    expect(s).toContain('1 source')
    expect(s).toContain('2 documents')
    expect(s).toContain('RAG')
    // Ids in a list cell would be unreadable and could leak internal identifiers into a screenshot.
    expect(s).not.toContain('erp')
    expect(s).not.toContain('d1')
  })

  test('singular and plural are both handled', () => {
    expect(describeScope(readKeyScope({ allowedDocumentIds: ['a'] }))).toContain('1 document')
    expect(describeScope(readKeyScope({ allowedDocumentIds: ['a', 'b'] }))).toContain('2 documents')
  })
})

/**
 * Fail-CLOSED reading of a stored scope.
 *
 * `readKeyScope` used to answer a present-but-wrong-typed column exactly as it answered an absent
 * one: `[]`, which this module defines as UNRESTRICTED. So `allowedDocumentIds: "doc-1"` widened a key
 * from one document to every document in the org, and `allowedTools: ["rag"]` (a case error) widened
 * it from "RAG only" to every tool. Both are worse than a denial: nothing errors, the answer looks
 * fine, and it is built from sources the operator never granted.
 *
 * The convention that is load-bearing and must NOT be collateral damage: an ABSENT column is still
 * `[]` = unrestricted, because every key created before this feature has empty arrays. The tests
 * below pin both directions, since "fail closed" and "empty means all" pull against each other.
 */
describe('api key scope — an unreadable stored value must not become "all"', () => {
  test('a bare string where a list is stored is REFUSED, not read as unrestricted', () => {
    // The exact widening: stored "doc-1" (one document intended) previously resolved to null = every
    // document in the org.
    const s = readKeyScope({ allowedDocumentIds: 'doc-1' })
    expect(s.malformed).toBeDefined()
    expect(() => resolveScope(s)).toThrow(ScopeConfigError)
  })

  test('a non-list integration value is REFUSED too — same defect, other column', () => {
    const s = readKeyScope({ allowedIntegrationIds: 'erp' })
    expect(() => resolveScope(s)).toThrow(ScopeConfigError)
  })

  test('a tool list whose every entry is unrecognised is REFUSED', () => {
    // Without this, the discard-unknown-names rule EMPTIES the list, and an empty list means every
    // tool. Case errors and typos are the realistic shapes.
    for (const stored of [['rag'], ['Rag'], ['SQLX'], ['rag', 'chat']]) {
      const s = readKeyScope({ allowedTools: stored })
      expect(s.allowedTools).toEqual([])
      expect(() => resolveScope(s)).toThrow(ScopeConfigError)
    }
  })

  test('a MIXED list still keeps its known names and is not treated as malformed', () => {
    // `['RAG','EXECUTE_SHELL']` is a forward-compatibility case (a newer build wrote the second one),
    // not a misconfiguration: the readable part is honoured and no problem is recorded.
    const s = readKeyScope({ allowedTools: ['RAG', 'EXECUTE_SHELL'] })
    expect(s.allowedTools).toEqual(['RAG'])
    expect(s.malformed).toBeUndefined()
    expect(resolveScope(s).tools).toEqual(['RAG'])
  })

  test('THE REGRESSION THAT MATTERS: absent/null columns stay unrestricted', () => {
    // Every key created before this feature has empty arrays, and a pre-migration row or test double
    // may omit the columns entirely. Treating "absent" as a fault would break all of them.
    for (const row of [{}, { allowedIntegrationIds: null, allowedDocumentIds: null, allowedTools: null }]) {
      const s = readKeyScope(row as never)
      expect(s.malformed).toBeUndefined()
      expect(resolveScope(s)).toEqual({ integrationIds: null, documentIds: null, tools: null })
    }
  })

  test('an all-blank list is absent, not malformed', () => {
    // `['']` is what a form submits when no checkbox is ticked — "no restriction configured", which is
    // unrestricted. It must not be classified as an unreadable value.
    const s = readKeyScope({ allowedDocumentIds: [''], allowedTools: ['   '] })
    expect(s.malformed).toBeUndefined()
    expect(resolveScope(s).documentIds).toBeNull()
  })

  test('an unreadable scope never RENDERS as "All sources"', () => {
    // The key list is where an operator audits "which key can read what". Labelling the one row whose
    // stored value could not be interpreted as "All sources" is the most misleading string available.
    expect(describeScope(readKeyScope({ allowedDocumentIds: 'doc-1' }))).toContain('Unreadable')
    expect(describeScope(readKeyScope({ allowedTools: ['rag'] }))).toContain('Unreadable')
    expect(describeScope(readKeyScope({}))).toBe('All sources')
  })

  test('ScopeConfigError is distinguishable from ScopeDeniedError', () => {
    // Different actors fix these: a denied SOURCE is the client's request, an unreadable SCOPE is the
    // administrator's key record. Collapsing them would send the operator after the wrong problem.
    const denied = (() => { try { resolveScope(readKeyScope({ allowedDocumentIds: ['a'] }), { documentIds: ['b'] }) } catch (e) { return e } })()
    const unreadable = (() => { try { resolveScope(readKeyScope({ allowedDocumentIds: 'a' })) } catch (e) { return e } })()
    expect(denied).toBeInstanceOf(ScopeDeniedError)
    expect(unreadable).toBeInstanceOf(ScopeConfigError)
    expect(unreadable).not.toBeInstanceOf(ScopeDeniedError)
  })
})
