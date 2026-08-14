import { describe, expect, test, mock } from 'bun:test'

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))
mock.module('@/lib/document-parsers', () => ({
  extractPdfTextFromBuffer: () => '',
  extractDocxTextFromBuffer: () => '',
  extractXlsxTextFromBuffer: () => '',
}))

import { chunkText, chunkTextParentDoc, splitStructuralBlocks } from './rag-chunking'

describe('chunkText', () => {
  test('splits on double newlines', () => {
    const result = chunkText('Para one.\n\nPara two.', { maxChars: 100 })
    expect(result).toEqual(['Para one.', 'Para two.'])
  })

  // Structure-aware contracts: a chunk must never straddle two sections, and a
  // table must stay with its header row.
  test('heading starts a new chunk (sections never merge)', () => {
    const doc = 'Intro paragraph about refunds.\n\nBAB II PROSEDUR\n\nKirim formulir ke HR.'
    const result = chunkText(doc, { maxChars: 500 })
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result.some((c) => c.includes('Intro paragraph') && c.includes('Kirim formulir'))).toBe(false)
  })

  test('markdown heading starts a new chunk', () => {
    const doc = 'first section text\n\n## Refund Policy\n\nCustomers may request refunds.'
    const result = chunkText(doc, { maxChars: 500 })
    expect(result.some((c) => c.startsWith('## Refund Policy'))).toBe(true)
    expect(result.some((c) => c.includes('first section') && c.includes('Customers may request'))).toBe(false)
  })

  test('table stays whole with its header row', () => {
    const table = 'Kategori\tBiaya\tTermin\nReguler\tGratis\t7 hari\nEnterprise\tGratis\t30 hari'
    const result = chunkText(`Intro sentence here.\n\n${table}`, { maxChars: 5000 })
    const tableChunk = result.find((c) => c.includes('Kategori'))
    expect(tableChunk).toBeDefined()
    expect(tableChunk).toContain('Enterprise')
    expect(tableChunk).not.toContain('Intro sentence')
  })

  test('ordinary capitalized sentence is NOT treated as a heading', () => {
    expect(splitStructuralBlocks('Para one.\n\nPara two.')).toEqual(['Para one.', 'Para two.'])
  })

  test('numbered outline headings split sections', () => {
    const doc = '1. Penerimaan Barang\nBarang diperiksa dua staf.\n2. Penyimpanan\nBarang masuk rak.'
    const blocks = splitStructuralBlocks(doc)
    expect(blocks.some((b) => b.startsWith('1. Penerimaan'))).toBe(true)
    expect(blocks.some((b) => b.startsWith('2. Penyimpanan'))).toBe(true)
  })

  test('returns empty for empty input', () => {
    expect(chunkText('')).toEqual([])
  })

  test('splits long chunks at word boundaries', () => {
    const long = 'word '.repeat(100).trim()
    const result = chunkText(long, { maxChars: 50, overlapChars: 0 })
    expect(result.length).toBeGreaterThan(1)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50 + 5)
    }
  })

  test('maxChunks caps output early (no full materialization)', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `paragraph ${i}`).join('\n\n')
    const chunks = chunkText(long, { maxChars: 100, maxChunks: 50 })
    expect(chunks.length).toBe(50)
  })
})

describe('chunkTextParentDoc', () => {
  test('returns empty for empty input', () => {
    expect(chunkTextParentDoc('')).toEqual([])
    expect(chunkTextParentDoc('   ')).toEqual([])
  })

  test('child chunks have parent context in contextPrefix', () => {
    const content = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'
    const chunks = chunkTextParentDoc(content, { childSize: 20, parentWindow: 80 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.contextPrefix.length).toBeGreaterThan(0)
      expect(chunk.contextPrefix.endsWith('\n\n')).toBe(true)
    }
  })

  test('parent window is larger than child content', () => {
    const content = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkTextParentDoc(content, { childSize: 30, parentWindow: 200 })
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.contextPrefix.length).toBeGreaterThanOrEqual(chunk.content.length)
    }
  })

  test('single short content produces one chunk', () => {
    const chunks = chunkTextParentDoc('hello world', { childSize: 100, parentWindow: 200 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].content).toBe('hello world')
    expect(chunks[0].contextPrefix).toContain('hello world')
  })

  test('child content is a substring of parent context', () => {
    const content = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkTextParentDoc(content, { childSize: 25, parentWindow: 100 })
    for (const chunk of chunks) {
      expect(chunk.contextPrefix).toContain(chunk.content)
    }
  })

  test('maxChunks caps output early', () => {
    const long = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkTextParentDoc(long, { childSize: 20, parentWindow: 80, maxChunks: 50 })
    expect(chunks.length).toBe(50)
  })
})
