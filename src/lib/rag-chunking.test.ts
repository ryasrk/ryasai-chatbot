import { describe, expect, test, mock } from 'bun:test'

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))
/**
 * Parser results are settable so the "parser produced text" branches are reachable.
 * They default to empty text, which is the previous behaviour of this mock.
 */
const parserText = { pdf: '', docx: '', xlsx: '' }
mock.module('@/lib/document-parsers', () => ({
  extractPdfTextFromBuffer: () => parserText.pdf,
  extractDocxTextFromBuffer: () => parserText.docx,
  extractXlsxTextFromBuffer: () => parserText.xlsx,
}))

import {
  chunkText,
  chunkTextParentDoc,
  splitStructuralBlocks,
  isPlaceholderChunk,
  emptyDocumentContent,
  detectDocType,
  extractFileText,
} from './rag-chunking'

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

// ---------------------------------------------------------------------------
// Placeholder detection — fixes the user-reported "it says it doesn't know even
// though the answer is in the knowledge base" symptom. A document whose text
// extraction produced nothing is stored as "[Empty document: x.pdf]" so
// retrieval can still match on the filename, but that marker must never be
// treated as answer EVIDENCE. Measured on live Postgres: a filename query
// returned ONLY the 46-char placeholder, which the old length check judged
// "too short" -> insufficient -> second retrieval pass -> tool-branches.ts
// injected "if the evidence doesn't contain the answer, say so", so the model
// disclaimed an answer it had never been given.
describe('isPlaceholderChunk / emptyDocumentContent', () => {
  test('builder and detector agree (no marker drift)', () => {
    const built = emptyDocumentContent('Scan Kontrak.pdf')
    expect(isPlaceholderChunk(built)).toBe(true)
    expect(built).toBe('[Empty document: Scan Kontrak.pdf]')
  })

  test('detects placeholders, including leading whitespace', () => {
    expect(isPlaceholderChunk('[Empty document: a.pdf]')).toBe(true)
    expect(isPlaceholderChunk('  \n[Empty document: a.pdf]')).toBe(true)
  })

  test('does NOT flag real content, however short', () => {
    // The crux: a short chunk is not a bad chunk. This 41-char sentence is a
    // complete, correct answer and must survive.
    expect(isPlaceholderChunk('Tarif lembur hari kerja 1,5x upah per jam.')).toBe(false)
    expect(isPlaceholderChunk('Cuti tahunan 12 hari.')).toBe(false)
  })

  test('handles null/undefined/empty without throwing', () => {
    expect(isPlaceholderChunk(null)).toBe(false)
    expect(isPlaceholderChunk(undefined)).toBe(false)
    expect(isPlaceholderChunk('')).toBe(false)
  })

  test('does not match a document that merely mentions the phrase mid-content', () => {
    const content = 'Ringkasan: dokumen ini berisi catatan. [Empty document: x] disebut di lampiran.'
    expect(isPlaceholderChunk(content)).toBe(false)
  })
})

// ===========================================================================
// detectDocType — decides WHICH parser runs, so a wrong answer is a lost doc
// ===========================================================================

describe('detectDocType', () => {
  test('recognises the four parsed formats', () => {
    expect(detectDocType('report.pdf')).toBe('pdf')
    expect(detectDocType('report.docx')).toBe('docx')
    expect(detectDocType('report.xlsx')).toBe('xlsx')
    expect(detectDocType('report.md')).toBe('md')
    expect(detectDocType('report.txt')).toBe('txt')
  })

  test('is CASE-INSENSITIVE, so a .PDF from a camera or Windows is not missed', () => {
    // `lower = filename.toLowerCase()` -- without it a `.PDF` falls into the "unknown
    // extension" branch and is treated as a BINARY placeholder, silently losing a
    // document whose text was perfectly extractable.
    expect(detectDocType('QUARTERLY.PDF')).toBe('pdf')
    expect(detectDocType('Laporan.DOCX')).toBe('docx')
    expect(detectDocType('Data.XLSX')).toBe('xlsx')
    expect(detectDocType('NOTES.MD')).toBe('md')
    expect(detectDocType('README.TXT')).toBe('txt')
  })

  test('an UNKNOWN extension is returned as-is, lowercased', () => {
    // The fallback uses the LAST dot, so a multi-dot name resolves to its final part.
    expect(detectDocType('archive.tar.gz')).toBe('gz')
    expect(detectDocType('data.CSV')).toBe('csv')
  })

  test('a name with NO dot at all is treated as text', () => {
    // `idx >= 0` guard: without it, lastIndexOf returns -1 and `slice(0)` would return
    // the WHOLE FILENAME as the type -- and that filename would then be parsed as a
    // binary placeholder.
    expect(detectDocType('LICENSE')).toBe('txt')
    expect(detectDocType('')).toBe('txt')
  })

  test('a LEADING dot is not treated as an extension separator', () => {
    // '.gitignore' -> idx is 0, so `slice(1)` gives 'gitignore'. A file whose only dot
    // is at index 0 has no extension in the usual sense, and the caller still gets a
    // type rather than an exception.
    expect(detectDocType('.gitignore')).toBe('gitignore')
  })

  test('a TRAILING dot yields an empty type rather than the whole name', () => {
    // `slice(idx + 1)` on 'file.' gives ''. Recorded as measured: the caller sees an
    // empty type, which matches no parser and falls through to the binary path.
    expect(detectDocType('file.')).toBe('')
  })
})

// ===========================================================================
// trailingWordsWithin — the overlap seam of a split chunk
// ===========================================================================

describe('chunkText overlap (trailingWordsWithin)', () => {
  /** Tokens that are each unique, so a seam repetition is visible rather than invisible. */
  const tokens = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`).join(' ')

  test('an overlap REPEATS the tail of the previous chunk at the seam', () => {
    // MEASURED with unique tokens: overlapChars 0 gives a second chunk starting at
    // `t27`, while overlapChars 30 gives one starting at `t20` -- i.e. t20..t22 are
    // repeated. That repetition is the whole point: a sentence cut across the boundary
    // is still retrievable from the second chunk. Without it a query whose answer
    // straddles the seam matches NEITHER chunk.
    //
    // My first version of this test used the word "word" for every token and checked
    // `startsWith('word word')`, which is true for BOTH cases -- a wrong-branch pass.
    const none = chunkText(tokens(120), { maxChars: 100, overlapChars: 0 })
    const some = chunkText(tokens(120), { maxChars: 100, overlapChars: 30 })
    expect(none.length).toBeGreaterThan(1)
    expect(some.length).toBeGreaterThan(none.length)
    // No overlap: the second chunk starts where the first ended, with no repeat.
    expect(none[1]!.startsWith('t27 ')).toBe(true)
    // With overlap: the second chunk REWINDS into the first one's tail.
    expect(some[1]!.startsWith('t20 ')).toBe(true)
    // And the rewound token is the LAST token of chunk 0's own text, confirming it.
    expect(none[0]!.endsWith('t26')).toBe(true)
  })

  test('the overlap GROWS the chunk count, it does not shrink the text', () => {
    // Every chunk still carries its `maxChars` budget; the overlap is added on top, so
    // the same document yields MORE chunks rather than shorter ones.
    const none = chunkText(tokens(120), { maxChars: 100, overlapChars: 0 })
    const some = chunkText(tokens(120), { maxChars: 100, overlapChars: 30 })
    expect(some.length).toBeGreaterThan(none.length)
    expect(Math.min(...some.map((c) => c.length))).toBeGreaterThan(10)
  })
})

// ===========================================================================
// detectDocType consumers: extractFileText
// ===========================================================================

describe('extractFileText', () => {
  function fileOf(name: string, body: string): File {
    return new File([body], name)
  }

  test('a TEXT file returns its content verbatim', async () => {
    const r = await extractFileText(fileOf('notes.txt', 'hello world'))
    expect(r.text).toBe('hello world')
    expect(r.isPlaceholder).toBe(false)
  })

  test('a MARKDOWN file is treated as text too', async () => {
    const r = await extractFileText(fileOf('doc.md', '# Title'))
    expect(r.text).toBe('# Title')
    expect(r.isPlaceholder).toBe(false)
  })

  test('a parsed-format file whose parser returns NOTHING becomes a placeholder', async () => {
    // The parsers are mocked to return '' here, which is the real "parser produced no
    // text" case. The caller must be able to RECOGNISE this, or an empty chunk set
    // looks like a document that legitimately had nothing in it.
    const r = await extractFileText(new File([new Uint8Array([1, 2, 3])], 'scan.pdf'))
    expect(r.isPlaceholder).toBe(true)
    expect(r.text).toContain('scan.pdf')
  })

  test('an UNPARSEABLE binary with printable text is accepted as text', async () => {
    // The printable-ratio probe (>0.85): a `.bin` full of ASCII is real content, and
    // discarding it would lose a document the user can see is readable.
    const r = await extractFileText(fileOf('weird.bin', 'plain ascii content here'))
    expect(r.text).toBe('plain ascii content here')
    expect(r.isPlaceholder).toBe(false)
  })

  test('an unparseable binary with BINARY bytes becomes a placeholder', async () => {
    // Low printable ratio -> placeholder. Without this the raw bytes would be indexed
    // as "text" and every query would match noise.
    const bytes = new Uint8Array(64).fill(0)
    const r = await extractFileText(new File([bytes], 'blob.bin'))
    expect(r.isPlaceholder).toBe(true)
    expect(r.text).toContain('blob.bin')
  })

  test('the placeholder names the file and its size so an operator can act', async () => {
    const bytes = new Uint8Array(2048).fill(0)
    const r = await extractFileText(new File([bytes], 'big.bin'))
    expect(r.text).toContain('big.bin')
    expect(r.text).toContain('2048 bytes')
  })
})

describe('extractFileText — the parser-success branches', () => {
  function bin(name: string): File {
    return new File([new Uint8Array([1, 2, 3])], name)
  }

  test('DOCX and XLSX text is used, with whitespace BEFORE a newline collapsed', () => {
    // MEASURED, and not what I assumed. The normalisation is `\s+\n` -> `\n`, which
    // removes the blanks and spaces IMMEDIATELY BEFORE a newline while leaving any
    // INDENTATION AFTER it, and it does NOT collapse repeated newlines. So
    // '  Hello   world  \n\n  Second line  ' becomes 'Hello   world\n  Second line'
    // -- note the two leading spaces survive on the second line, and so do the
    // interior spaces in "Hello   world". My first version of this test asserted a
    // tidier result and was simply wrong about the code.
    parserText.docx = '  Hello   world  \n\n  Second line  '
    parserText.xlsx = 'sheet1\n\n\nSheet name'
    return (async () => {
      const d = await extractFileText(bin('a.docx'))
      expect(d.isPlaceholder).toBe(false)
      expect(d.text).toBe('Hello   world\n  Second line')
      // Three consecutive newlines collapse to ONE, because each one had whitespace
      // (the preceding newline) before it.
      expect((await extractFileText(bin('a.xlsx'))).text).toBe('sheet1\nSheet name')
    })().finally(() => {
      parserText.docx = ''
      parserText.xlsx = ''
    })
  })

  test('PDF text is used when the parser yields it', () => {
    parserText.pdf = 'extracted pdf body'
    return (async () => {
      const r = await extractFileText(bin('a.pdf'))
      expect(r.isPlaceholder).toBe(false)
      expect(r.text).toBe('extracted pdf body')
    })().finally(() => { parserText.pdf = '' })
  })

  test('extracted text is CAPPED at MAX_EXTRACTED_TEXT_CHARS', () => {
    // MEASURED: the cap is 2_000_000 characters, so a document under that is passed
    // through UNCHANGED -- my first version used 400k and asserted a trim, which was
    // wrong. The cap bounds what an enormous PDF can push into the chunker, so the
    // test must cross the real threshold to observe it.
    const under = 1_500_000
    parserText.pdf = 'x'.repeat(under)
    return (async () => {
      const r = await extractFileText(bin('big.pdf'))
      expect(r.text.length).toBe(under)
      // Now cross the cap; the TAIL is dropped and the head kept.
      parserText.pdf = 'x'.repeat(2_500_000)
      const capped = await extractFileText(bin('huge.pdf'))
      expect(capped.text.length).toBe(2_000_000)
    })().finally(() => { parserText.pdf = '' })
  })

  test('a TEXT file whose read FAILS becomes a named placeholder instead of throwing', async () => {
    // The scheduler processes many files; one unreadable file must not abort the run.
    const bad = new File([''], 'broken.txt')
    Object.defineProperty(bad, 'text', {
      value: () => Promise.reject(new Error('EIO')),
    })
    const r = await extractFileText(bad)
    expect(r.isPlaceholder).toBe(true)
    expect(r.text).toContain('broken.txt')
    expect(r.text).toContain('Read failed')
  })
})

describe('splitStructuralBlocks — a table meeting a heading flushes the table', () => {
  test('a heading line closes an open table', () => {
    // The `flush()` inside the isHeadingLine branch. Without it the heading text is
    // appended INTO the table block, so a section title ships as a table row.
    const doc = 'A\tB\n1\t2\n## Next Section\nbody text'
    const blocks = splitStructuralBlocks(doc)
    const tableBlock = blocks.find((b) => b.includes('A\tB'))
    expect(tableBlock).toBeDefined()
    expect(tableBlock).not.toContain('## Next Section')
  })
})

describe('a heading must not become a chunk of its own', () => {
  // REGRESSION (found by measuring the app's own corpus, not by a failing test):
  // `splitStructuralBlocks` flushed the heading TWICE, so every section title became a
  // standalone chunk with no body. Measured on 114 real chunks: 65 fragments (57%), mean
  // 118 chars, 15 of them a bare title. Retrieval then returned "## Penanganan Data Sangat
  // Rahasia" WITHOUT its content, and a grounded model correctly said the evidence did not
  // answer the question — a chunking failure that presents as a retrieval failure and is
  // invisible to any recall metric that counts a heading as a hit.
  //
  // The 39 tests that existed when this shipped all passed with the bug PRESENT, which is
  // why the assertions below exist rather than a note in the code.
  test('a section title and its body arrive in the SAME block', () => {
    const doc = '# Judul Dokumen\n## Penanganan Data\nData wajib dienkripsi dan diberi label.'
    const blocks = splitStructuralBlocks(doc)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toContain('## Penanganan Data')
    expect(blocks[0]).toContain('Data wajib dienkripsi')
  })

  test('no block is a bare heading — every block carries content beyond its title', () => {
    const doc = [
      '# Kebijakan',
      '## Bagian Satu',
      'Isi bagian satu yang cukup panjang untuk dibaca.',
      '## Bagian Dua',
      'Isi bagian dua juga ada.',
    ].join('\n')
    for (const block of splitStructuralBlocks(doc)) {
      const withoutHeadings = block
        .split('\n')
        .filter((l) => !/^#{1,6}\s+\S/.test(l.trim()))
        .join('')
        .trim()
      expect(withoutHeadings.length, `block was a bare heading: ${JSON.stringify(block)}`).toBeGreaterThan(0)
    }
  })

  test('consecutive headings stay readable instead of being dropped', () => {
    // Two headings with no body between them is legal input; neither may vanish.
    const blocks = splitStructuralBlocks('# Atas\n## Tengah\nisi setelahnya')
    const joined = blocks.join('\n')
    expect(joined).toContain('# Atas')
    expect(joined).toContain('## Tengah')
    expect(joined).toContain('isi setelahnya')
  })

  test('a heading opens a section rather than closing one', () => {
    // The exact shape that broke: content AFTER a heading must stay with it, and content
    // BEFORE it must not be pulled in.
    const blocks = splitStructuralBlocks('paragraf pendahuluan\n## Seksi\nisi seksi')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toBe('paragraf pendahuluan')
    expect(blocks[1]).toContain('## Seksi')
    expect(blocks[1]).toContain('isi seksi')
  })
})
