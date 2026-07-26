import { describe, expect, test, mock } from 'bun:test'

const TEST_PLUGINS = [
  { id: 'p1', toolId: 'weather', name: 'Weather', description: 'Get weather forecast for a city', keywords: 'cuaca,weather,suhu,temperature,hujan,rain,forecast,prakiraan,wind,angin,humidity,lembab,jakarta', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'weather', manifestJson: '{}' },
  { id: 'p2', toolId: 'translate', name: 'Translate', description: 'Translate text between languages', keywords: 'translate,terjemah,translation,bahasa,language,english,indonesia', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'translation', manifestJson: '{}' },
  { id: 'p3', toolId: 'calculator', name: 'Calculator', description: 'Calculate math expressions', keywords: 'calculate,calculator,hitung,kalkulator,math,matematika,arithmetic,sum,add,subtract,multiply,divide,sqrt,power', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'calculator', manifestJson: '{}' },
  { id: 'p4', toolId: 'docsearch', name: 'DocSearch', description: 'Search documentation and code examples', keywords: 'documentation,doc,syntax,code,programming,search,example,react,vue,python,javascript,typescript,useEffect,hook', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'documentation', manifestJson: '{}' },
  { id: 'p5', toolId: 'datetime', name: 'DateTime', description: 'Get current date and time', keywords: 'tanggal,date,time,waktu,jam,hari,bulan,tahun,now,sekarang,current,datetime', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'datetime', manifestJson: '{}' },
  { id: 'p6', toolId: 'news', name: 'News', description: 'Get latest news headlines', keywords: 'news,berita,headline,artikel,indonesia,world,dunia,terkini,latest', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'news', manifestJson: '{}' },
]

mock.module('@/lib/db', () => ({
  db: {
    plugin: { findMany: async () => TEST_PLUGINS },
  },
}))

import { selectRelevantPlugins } from './plugin-selector'

describe('plugin-selector', () => {
  test('returns empty for empty query', async () => {
    const result = await selectRelevantPlugins({ query: '' })
    expect(result).toEqual([])
  })

  test('returns empty for stop-words-only query', async () => {
    const result = await selectRelevantPlugins({ query: 'yang dan di ke untuk' })
    expect(result).toEqual([])
  })

  test('selects weather plugins for weather query', async () => {
    const result = await selectRelevantPlugins({ query: 'Cuaca di Jakarta hari ini' })
    expect(result.length).toBeGreaterThan(0)
    expect(result.some((p) => p.subcategory === 'weather')).toBe(true)
  })

  test('selects translate plugin for translation query', async () => {
    const result = await selectRelevantPlugins({ query: 'Terjemahkan teks ini ke bahasa inggris' })
    expect(result.length).toBeGreaterThan(0)
    expect(result.some((p) => p.subcategory === 'translation')).toBe(true)
  })

  test('selects calculator plugin for math query', async () => {
    const result = await selectRelevantPlugins({ query: 'Hitung akar kuadrat dari 16' })
    expect(result.length).toBeGreaterThan(0)
    expect(result.some((p) => p.subcategory === 'calculator')).toBe(true)
  })

  test('selects docsearch plugin for code query', async () => {
    const result = await selectRelevantPlugins({ query: 'Cara menggunakan react useEffect hook' })
    expect(result.length).toBeGreaterThan(0)
    expect(result.some((p) => p.subcategory === 'documentation')).toBe(true)
  })

  test('selects datetime plugin for time query', async () => {
    const result = await selectRelevantPlugins({ query: 'Jam berapa sekarang di Jakarta' })
    expect(result.length).toBeGreaterThan(0)
    expect(result.some((p) => p.subcategory === 'datetime')).toBe(true)
  })

  test('selects news plugin for news query', async () => {
    const result = await selectRelevantPlugins({ query: 'Berita terbaru hari ini' })
    expect(result.length).toBeGreaterThan(0)
    expect(result.some((p) => p.subcategory === 'news')).toBe(true)
  })

  test('scores are sorted descending', async () => {
    const result = await selectRelevantPlugins({ query: 'crypto weather email', topK: 10 })
    for (let i = 1; i < result.length; i++) {
      expect(result[i].score).toBeLessThanOrEqual(result[i - 1].score)
    }
  })

  test('does not select irrelevant plugins', async () => {
    const result = await selectRelevantPlugins({ query: 'gambar', minScore: 0.5 })
    const toolIds = result.map((p) => p.toolId)
    expect(toolIds).not.toContain('weather')
    expect(toolIds).not.toContain('calculator')
  })
})
