import { describe, expect, test } from 'bun:test'
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
