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

const { routeQueryOrDegrade } = await import('./tool-router-routing')

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
