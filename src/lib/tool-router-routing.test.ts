import { describe, expect, mock, test } from 'bun:test'
import { LlmProviderError } from '@/lib/llm-client-utils'
import { LlmNotConfiguredError } from '@/lib/errors'

let behaviour: 'ok' | 'provider' | 'unconfigured' = 'ok'
mock.module('@/lib/ai', () => ({
  routeQuery: async () => {
    if (behaviour === 'provider') throw new LlmProviderError(null, 'The operation was aborted due to timeout')
    if (behaviour === 'unconfigured') throw new LlmNotConfiguredError()
    return { decision: 'SQL', reason: 'model said so' }
  },
}))

const { routeQueryOrDegrade, webPickTheDocumentsMayHold } = await import('./tool-router-routing')

const ctx = (has: { docs: boolean; dbs: boolean }) => ({
  question: 'What percentage of those at the end of life now choose euthanasia?',
  hasDocuments: has.docs,
  hasIntegrations: has.dbs,
  hasRestApis: false,
})

describe('routeQueryOrDegrade — the router fallback must not turn a provider timeout into HTTP 500', () => {
  test('a working router decides', async () => {
    behaviour = 'ok'
    expect((await routeQueryOrDegrade(ctx({ docs: true, dbs: true }))).decision).toBe('SQL')
  })

  test('a provider failure routes by what the org has: documents, then a database, then chat', async () => {
    // MEASURED 2026-10-05: the selector timed out (swallowed), then this call timed out and the turn failed with 500.
    behaviour = 'provider'
    expect((await routeQueryOrDegrade(ctx({ docs: true, dbs: true }))).decision).toBe('RAG')
    expect((await routeQueryOrDegrade(ctx({ docs: false, dbs: true }))).decision).toBe('SQL')
    expect((await routeQueryOrDegrade(ctx({ docs: false, dbs: false }))).decision).toBe('CHAT')
  })

  test('an UNCONFIGURED LLM still fails closed', async () => {
    behaviour = 'unconfigured'
    await expect(routeQueryOrDegrade(ctx({ docs: true, dbs: true }))).rejects.toBeInstanceOf(LlmNotConfiguredError)
  })
})

describe('webPickTheDocumentsMayHold — which web picks the documents-first probe may take over', () => {
  const pick = (selectedToolId: string | undefined, question: string, decision = 'PLUGIN') =>
    webPickTheDocumentsMayHold({ decision: decision as never, selectedToolId, question })

  test('a web pick on a plain question: yes', () => {
    expect(pick('web_search', 'What percentage of those at the end of life now choose euthanasia?')).toBe(true)
    expect(pick('web_fetch', 'In what year did rejection engines catch on with the public?')).toBe(true)
  })

  test('the user asked for the web, or gave a page: no', () => {
    expect(pick('web_search', 'Search the web for euthanasia statistics')).toBe(false)
    expect(pick('web_search', 'cari di internet berapa persen eutanasia')).toBe(false)
    expect(pick('web_fetch', 'Summarise https://example.org/report')).toBe(false)
    expect(pick('web_fetch', 'what does www.example.org say')).toBe(false)
    expect(pick('web_search', 'latest news online about tariffs')).toBe(false)
  })

  test('a plan of several web calls: yes; a plan that also wants a data source: no', () => {
    const plan = (ids: string[]) => webPickTheDocumentsMayHold({ decision: 'PLUGIN' as never, selectedToolId: 'web_fetch', requestedToolIds: ids, question: 'What percentage choose euthanasia?' })
    expect(plan(['web_fetch', 'web_fetch'])).toBe(true)
    expect(plan(['web_fetch', 'sql'])).toBe(false)
  })

  test('any other tool, or a fallback route that names none: no', () => {
    expect(pick('plugin:weather', 'weather in Jakarta')).toBe(false)
    expect(pick(undefined, 'What percentage choose euthanasia?')).toBe(false)
    expect(pick('web_search', 'What percentage choose euthanasia?', 'CHAT')).toBe(false)
  })
})
