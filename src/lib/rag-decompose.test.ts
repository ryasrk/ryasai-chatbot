import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { RetrievedChunk } from '@/lib/rag'

const llm = { reply: '' as string, throws: false, calls: [] as Array<{ purpose?: string; messages: unknown }> }
mock.module('@/lib/llm-config', () => ({ getRoleLlmConfig: async () => ({ provider: 'OPENAI_COMPATIBLE', model: 'm' }) }))
mock.module('@/lib/llm-client', () => ({
  chatOnce: async (_cfg: unknown, messages: unknown, _t: unknown, purpose?: string) => {
    llm.calls.push({ purpose, messages })
    if (llm.throws) throw new Error('provider down')
    return llm.reply
  },
}))

const { needsDecomposition, parseSubQuestions, decomposeForRetrieval, coverageMerge, interleavePools, retrieveCompound } = await import('@/lib/rag-decompose')

beforeEach(() => {
  llm.reply = ''
  llm.throws = false
  llm.calls = []
})

describe('needsDecomposition — which questions get a model split', () => {
  // The multi-hop questions of the live eval that the regex split into fragments, or not at all.
  test.each([
    'How many days after the Information Security Policy takes effect does the Access System SOP become effective?',
    'By how many days does the automatic suspension threshold for inactive accounts exceed the backup data retention period?',
    'Who is the Chief Operating Officer that approved both the inbound and outbound warehouse SOPs?',
    'Siapa Chief Operating Officer yang meninjau kebijakan cuti sekaligus kebijakan manajemen kinerja dan pelatihan karyawan Arunika?',
    'Berapa selisih nilai pertanggungan tersebut dengan limit polis asuransi untuk gudang JKT-02?',
  ])('%s', (q) => expect(needsDecomposition(q)).toBe(true))

  test.each([
    'Berapa hari cuti tahunan karyawan tetap?',
    'What is the reimbursement limit for taxi fares?',
    'Apa saja syarat dan ketentuan pengembalian barang?',
  ])('a single question is not split: %s', (q) => expect(needsDecomposition(q)).toBe(false))
})

describe('parseSubQuestions — only usable output is used', () => {
  const original = 'Who approved both the inbound and outbound SOPs?'

  test('two or three standalone questions are kept', () => {
    expect(parseSubQuestions('["Who approved the inbound warehouse SOP?", "Who approved the outbound warehouse SOP?"]', original))
      .toEqual(['Who approved the inbound warehouse SOP?', 'Who approved the outbound warehouse SOP?'])
  })

  test('a fenced or object-wrapped list is read', () => {
    expect(parseSubQuestions('```json\n{"subQuestions": ["Who approved the inbound SOP?", "Who approved the outbound SOP?"]}\n```', original)).toHaveLength(2)
  })

  test.each([
    ['not JSON', 'Who approved the inbound SOP?'],
    ['one item', '["Who approved the inbound SOP?"]'],
    ['a fragment', '["Who approved the inbound SOP?", "outbound SOPs?"]'],
    ['the original repeated', `["${original}", "Who approved the outbound SOP?"]`],
  ])('%s → nothing', (_label, raw) => expect(parseSubQuestions(raw, original)).toEqual([]))

  test('more than three are cut to three', () => {
    const many = JSON.stringify(['What is policy A?', 'What is policy B?', 'What is policy C?', 'What is policy D?'])
    expect(parseSubQuestions(many, original)).toHaveLength(3)
  })
})

describe('decomposeForRetrieval', () => {
  const q = 'How many days after the Information Security Policy takes effect does the Access System SOP become effective?'

  test('a compound question is split by the model into standalone questions', async () => {
    llm.reply = '["When does the Information Security Policy take effect?", "When does the Access System SOP become effective?"]'
    expect(await decomposeForRetrieval(q)).toEqual([
      'When does the Information Security Policy take effect?',
      'When does the Access System SOP become effective?',
    ])
    expect(llm.calls[0].purpose).toBe('rag-decompose')
  })

  test('a simple question makes no model call', async () => {
    expect(await decomposeForRetrieval('Berapa hari cuti tahunan karyawan tetap?')).toEqual(['Berapa hari cuti tahunan karyawan tetap?'])
    expect(llm.calls).toHaveLength(0)
  })

  test('a failed or unusable model reply falls back to the heuristic split, never to nothing', async () => {
    llm.throws = true
    expect((await decomposeForRetrieval(q)).length).toBeGreaterThanOrEqual(1)
    llm.throws = false
    llm.reply = 'I cannot do that'
    expect((await decomposeForRetrieval(q)).length).toBeGreaterThanOrEqual(1)
  })
})

describe('coverageMerge — every sub-question keeps its best chunk', () => {
  const chunk = (id: string, score: number) => ({ chunkId: id, score } as unknown as RetrievedChunk)

  test('a sub-question whose best chunk the joint rerank dropped gets it back, replacing the weakest', () => {
    const reranked = [chunk('a1', 0.9), chunk('a2', 0.8), chunk('a3', 0.7)]
    const perSub = [[chunk('a1', 0.9), chunk('a2', 0.8)], [chunk('b1', 0.6), chunk('b2', 0.5)]]
    expect(coverageMerge(reranked, perSub, 3).map((c) => c.chunkId)).toEqual(['a1', 'a2', 'b1'])
  })

  test('nothing changes when every sub-question is already represented', () => {
    const reranked = [chunk('a1', 0.9), chunk('b1', 0.8), chunk('a2', 0.7)]
    expect(coverageMerge(reranked, [[chunk('a1', 0.9)], [chunk('b1', 0.6)]], 3).map((c) => c.chunkId)).toEqual(['a1', 'b1', 'a2'])
  })

  test('room left under topK is used rather than displacing anything', () => {
    const reranked = [chunk('a1', 0.9)]
    expect(coverageMerge(reranked, [[chunk('a1', 0.9)], [chunk('b1', 0.6)]], 3).map((c) => c.chunkId)).toEqual(['a1', 'b1'])
  })

  test('a sub-question with no chunks is skipped', () => {
    const reranked = [chunk('a1', 0.9), chunk('a2', 0.8)]
    expect(coverageMerge(reranked, [[chunk('a1', 0.9)], []], 2).map((c) => c.chunkId)).toEqual(['a1', 'a2'])
  })
})

describe('interleavePools — the rerank pool holds every hop', () => {
  const chunk = (id: string) => ({ chunkId: id, score: 0 } as unknown as RetrievedChunk)
  test('round-robin across sub-questions, deduplicated, capped', () => {
    const pools = [[chunk('a1'), chunk('a2'), chunk('a3')], [chunk('b1'), chunk('a1'), chunk('b2')]]
    expect(interleavePools(pools, 4).map((c) => c.chunkId)).toEqual(['a1', 'b1', 'a2', 'a3'])
  })
  test('an uneven split still drains the longer pool', () => {
    expect(interleavePools([[chunk('a1')], [chunk('b1'), chunk('b2'), chunk('b3')]], 10).map((c) => c.chunkId)).toEqual(['a1', 'b1', 'b2', 'b3'])
  })
})

describe('retrieveCompound — each hop is searched on its own and kept', () => {
  const chunk = (id: string, score: number) => ({ chunkId: id, score } as unknown as RetrievedChunk)
  const pools: Record<string, RetrievedChunk[]> = {
    'When does the security policy take effect?': [chunk('sec1', 0.9), chunk('sec2', 0.8)],
    'When does the access SOP become effective?': [chunk('acc1', 0.4)],
  }
  const merge = (rs: Array<{ chunks: RetrievedChunk[] }>) => ({ chunks: rs.flatMap((r) => r.chunks) })

  test('every sub-question is retrieved, and a hop the joint rerank dropped is restored', async () => {
    const asked: string[] = []
    const { merged, perSub } = await retrieveCompound({
      question: 'How many days after the security policy does the access SOP take effect?',
      subQuestions: Object.keys(pools),
      topK: 2,
      retrieve: async (q) => { asked.push(q); return { chunks: pools[q] ?? [] } },
      expand: (q) => [q],
      merge,
      // A reranker that prefers the first hop's chunks for the whole question.
      rerank: async (_q, pool, k) => pool.filter((c) => c.chunkId.startsWith('sec')).slice(0, k),
    })
    expect(asked.sort()).toEqual(Object.keys(pools).sort())
    expect(merged.chunks.map((c) => c.chunkId)).toEqual(['sec1', 'acc1'])
    expect(perSub).toHaveLength(2)
  })

  test('with no reranker the interleaved pool is cut to top-K', async () => {
    const { merged } = await retrieveCompound({
      question: 'q', subQuestions: Object.keys(pools), topK: 2,
      retrieve: async (q) => ({ chunks: pools[q] ?? [] }), expand: (q) => [q], merge, rerank: null,
    })
    expect(merged.chunks.map((c) => c.chunkId)).toEqual(['sec1', 'acc1'])
  })
})
