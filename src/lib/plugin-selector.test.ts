import { describe, expect, test, mock } from 'bun:test'

const TEST_PLUGINS = [
  { id: 'p1', toolId: 'weather', name: 'Weather', description: 'Get weather forecast for a city', keywords: 'cuaca,weather,suhu,temperature,hujan,rain,forecast,prakiraan,wind,angin,humidity,lembab,jakarta', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'weather', manifestJson: '{}' },
  { id: 'p2', toolId: 'translate', name: 'Translate', description: 'Translate text between languages', keywords: 'translate,terjemah,translation,bahasa,language,english,indonesia', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'translation', manifestJson: '{}' },
  { id: 'p3', toolId: 'calculator', name: 'Calculator', description: 'Calculate math expressions', keywords: 'calculate,calculator,hitung,kalkulator,math,matematika,arithmetic,sum,add,subtract,multiply,divide,sqrt,power', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'calculator', manifestJson: '{}' },
  { id: 'p4', toolId: 'docsearch', name: 'DocSearch', description: 'Search documentation and code examples', keywords: 'documentation,doc,syntax,code,programming,search,example,react,vue,python,javascript,typescript,useEffect,hook', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'documentation', manifestJson: '{}' },
  { id: 'p5', toolId: 'datetime', name: 'DateTime', description: 'Get current date and time', keywords: 'tanggal,date,time,waktu,jam,hari,bulan,tahun,now,sekarang,current,datetime', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'datetime', manifestJson: '{}' },
  { id: 'p6', toolId: 'news', name: 'News', description: 'Get latest news headlines', keywords: 'news,berita,headline,artikel,indonesia,world,dunia,terkini,latest', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: 'external', subcategory: 'news', manifestJson: '{}' },
]

/** Set by a test to swap the plugin table for one call, then reset. */
let pluginsOverride: unknown[] | null = null
const findManyCalls: Array<Record<string, unknown>> = []

mock.module('@/lib/db', () => ({
  db: {
    plugin: {
      findMany: async (args: Record<string, unknown>) => {
        findManyCalls.push(args ?? {})
        return pluginsOverride ?? TEST_PLUGINS
      },
    },
  },
}))

import { selectRelevantPlugins, getAllPluginsGrouped } from './plugin-selector'

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

// ===========================================================================
// getAllPluginsGrouped — the category tree the plugin picker renders
// ===========================================================================

describe('getAllPluginsGrouped', () => {
  test('groups plugins by category then subcategory', async () => {
    const grouped = await getAllPluginsGrouped()
    // Every test plugin shares category 'external' with a distinct subcategory.
    expect(Object.keys(grouped)).toEqual(['external'])
    expect(Object.keys(grouped.external).sort()).toEqual([
      'calculator', 'datetime', 'documentation', 'news', 'translation', 'weather',
    ])
    expect(grouped.external.weather).toHaveLength(1)
    expect(grouped.external.weather[0].toolId).toBe('weather')
  })

  test('a MISSING category or subcategory becomes "general", not an empty key', async () => {
    // `p.category || 'general'`. An empty-string key would render as a nameless
    // group in the picker, and `undefined` would create the literal key "undefined".
    pluginsOverride = [
      { ...TEST_PLUGINS[0], id: 'g1', toolId: 'no-cat', category: null, subcategory: null },
      { ...TEST_PLUGINS[0], id: 'g2', toolId: 'blank-cat', category: '', subcategory: '' },
      { ...TEST_PLUGINS[0], id: 'g3', toolId: 'cat-only', category: 'data', subcategory: undefined },
    ]
    try {
      const grouped = await getAllPluginsGrouped()
      expect(Object.keys(grouped).sort()).toEqual(['data', 'general'])
      expect(grouped.general.general.map((p) => p.toolId)).toEqual(['no-cat', 'blank-cat'])
      expect(grouped.data.general.map((p) => p.toolId)).toEqual(['cat-only'])
    } finally {
      pluginsOverride = null
    }
  })

  test('each entry carries the fields the picker needs, with score 0', async () => {
    // The grouped view is a BROWSER of what exists; scoring is done separately by
    // selectRelevantPlugins. A non-zero score here would make the picker imply a
    // relevance it never computed.
    const grouped = await getAllPluginsGrouped()
    const entry = grouped.external.weather[0]
    expect(entry).toEqual({
      id: 'p1', toolId: 'weather', name: 'Weather',
      description: 'Get weather forecast for a city',
      manifestJson: '{}', category: 'external', subcategory: 'weather',
      chatEnabled: true, agenticEnabled: true, score: 0,
    })
    expect(entry.score).toBe(0)
  })

  test('the query asks for a STABLE order (category, subcategory, name)', async () => {
    // The DB order decides the order WITHIN each subcategory, so a missing orderBy
    // would let the picker reshuffle between page loads.
    findManyCalls.length = 0
    await getAllPluginsGrouped()
    expect(findManyCalls[0]?.orderBy).toEqual([
      { category: 'asc' }, { subcategory: 'asc' }, { name: 'asc' },
    ])
  })

  test('an EMPTY plugin table yields an empty object, not a crash', async () => {
    pluginsOverride = []
    try {
      expect(await getAllPluginsGrouped()).toEqual({})
    } finally {
      pluginsOverride = null
    }
  })
})
