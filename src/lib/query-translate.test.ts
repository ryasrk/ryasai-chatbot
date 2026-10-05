import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const state = { cfg: { model: 'm' } as unknown, reply: '' as string, throws: false, calls: [] as Array<{ purpose: string; user: string }> }
mock.module('@/lib/llm-config', () => ({ getRoleLlmConfig: async () => state.cfg }))
mock.module('@/lib/llm-client', () => ({
  chatOnce: async (_cfg: unknown, messages: Array<{ content: string }>, _t: number, purpose: string) => {
    state.calls.push({ purpose, user: messages[1].content })
    if (state.throws) throw new Error('provider down')
    return state.reply
  },
}))

const { translateForRetrieval } = await import('./query-translate')

beforeEach(() => {
  state.cfg = { model: 'm' }
  state.reply = ''
  state.throws = false
  state.calls = []
})
afterEach(() => {
  delete process.env.RAG_TRANSLATE_ON_MISS
})

describe('translateForRetrieval', () => {
  test('returns the translation, under its own purpose', async () => {
    state.reply = '"Berapa batas waktu pengajuan klaim asuransi kargo?"'
    expect(await translateForRetrieval('What is the cargo insurance claim deadline?')).toBe('Berapa batas waktu pengajuan klaim asuransi kargo?')
    expect(state.calls[0]).toEqual({ purpose: 'query-translate', user: 'What is the cargo insurance claim deadline?' })
  })

  test('nothing to search with: empty, unchanged, or an essay instead of a question', async () => {
    state.reply = '   '
    expect(await translateForRetrieval('q one')).toBeNull()
    state.reply = 'Q One'
    expect(await translateForRetrieval('q one')).toBeNull()
    state.reply = 'x'.repeat(500)
    expect(await translateForRetrieval('q one')).toBeNull()
  })

  test('no model, a provider failure, or the switch off: null, never a throw', async () => {
    state.cfg = null
    expect(await translateForRetrieval('q')).toBeNull()
    state.cfg = { model: 'm' }
    state.throws = true
    expect(await translateForRetrieval('q')).toBeNull()
    process.env.RAG_TRANSLATE_ON_MISS = 'false'
    state.throws = false
    state.calls = []
    expect(await translateForRetrieval('q')).toBeNull()
    expect(state.calls).toHaveLength(0)
  })
})
