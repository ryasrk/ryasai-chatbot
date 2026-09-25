import { describe, expect, test } from 'bun:test'
import { selectRelevantPlugins } from './plugin-selector'
import { pluginMatchDominatesQuestion, tokenizeForPluginGate } from './ai'

/**
 * A plugin must not hijack a data question.
 *
 * MEASURED on this deployment before the gate existed: the `datetime` plugin declares the bare
 * keyword "tahun" (year), so ANY question containing a time word was promoted off the route the
 * classifier had chosen. 5 of 6 database questions carrying a time word were hijacked, e.g.
 *
 *     "Tampilkan pesanan per jam."          -> Current Date & Time  (score 0.415)
 *     "Penjualan bulan lalu berapa?"        -> Current Date & Time  (score 0.233)
 *     "Berapa total pendapatan tahun 2024?" -> Current Date & Time  (score 0.175)
 *
 * Why these are deterministic: the scorer is a pure function of (question, plugin keywords), so
 * unlike a routeQuery measurement they do not vary with the model. A model-in-the-loop number was
 * tried first and was misleading — the same question measured 8/10, then 15/21, then 5/5 SQL when
 * run alone, because it was really measuring the classifier's variance, not this gate.
 */
const datetime = {
  id: 'dt', toolId: 'datetime', name: 'Current Date & Time',
  description: 'Current date and time for any IANA timezone, including DST status.',
  category: 'utility', subcategory: 'datetime', chatEnabled: true, agenticEnabled: true,
  manifestJson: '{}',
  keywords:
    'tanggal,date,time,waktu,jam,hari,bulan,tahun,now,sekarang,current,datetime,timezone,zona,utc,offset,dst,daylight',
}
const calculator = {
  id: 'calc', toolId: 'calculator', name: 'Calculator',
  description: 'Evaluate a mathematical expression exactly.',
  category: 'utility', subcategory: 'calculation', chatEnabled: true, agenticEnabled: true,
  manifestJson: '{}',
  keywords:
    'calculate,calculator,compute,math,arithmetic,hitung,kalkulator,matematika,expression,percent,persen',
}

async function matchFor(rows: unknown[], query: string) {
  const hits = await selectRelevantPlugins({ query, topK: 1, _rows: rows } as never)
  return { hits, promote: pluginMatchDominatesQuestion(query, hits[0]?.matchedTokens ?? []) }
}

describe('a plugin must not hijack a data question', () => {
  test('a data question that merely CONTAINS a time word scores high enough to matter', async () => {
    const { hits } = await matchFor([datetime], 'Tampilkan pesanan per jam.')
    // It clears the 0.05 threshold the caller passes — which is exactly why the fix is a QUALITY
    // gate rather than a different number. A threshold cannot separate this from a real hit.
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].score).toBeGreaterThan(0.05)
  })

  test('…but it is NOT promoted', async () => {
    const { promote } = await matchFor([datetime], 'Tampilkan pesanan per jam.')
    expect(promote).toBe(false)
  })

  test('every database question carrying a time word is refused promotion', async () => {
    const questions = [
      'Tampilkan pesanan per jam.',
      'Penjualan bulan lalu berapa?',
      'Berapa total pendapatan tahun 2024?',
      'Data transaksi hari ini ada berapa?',
      'Berapa banyak film yang dirilis tahun 2005?',
    ]
    for (const q of questions) {
      const { promote } = await matchFor([datetime], q)
      expect({ q, promote }).toEqual({ q, promote: false })
    }
  })

  test('a question genuinely ABOUT the time is still promoted', async () => {
    const { promote } = await matchFor([datetime], 'Jam berapa sekarang?')
    expect(promote).toBe(true)
  })

  test('a question that LEADS with the plugin verb is promoted', async () => {
    const { promote } = await matchFor([calculator], 'Hitung 15% dari 2 juta.')
    expect(promote).toBe(true)
  })

  test('two matched tokens promote regardless of position', () => {
    expect(pluginMatchDominatesQuestion('apa waktu sholat di sini', ['waktu', 'sholat'])).toBe(true)
  })

  test('no matched tokens never promotes', () => {
    expect(pluginMatchDominatesQuestion('berapa total penjualan', [])).toBe(false)
  })

  test('the gate keeps intent words — stripping them was an over-correction', () => {
    // The first version of the tokenizer dropped "berapa"/"tampilkan"/"what", which made a
    // legitimately time-focused question look like one incidental word. Intent words are content.
    const tokens = tokenizeForPluginGate('What time is it in Jakarta?')
    expect(tokens).toContain('what')
    expect(tokens).toContain('time')
    expect(tokens).not.toContain('is')
  })
})
