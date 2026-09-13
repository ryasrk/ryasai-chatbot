import { describe, expect, test } from 'bun:test'
import zlib from 'node:zlib'
import { extractDocxTextFromBuffer, extractPdfTextFromBuffer, extractXlsxTextFromBuffer } from './document-parsers'

describe('document parsers', () => {
  test('extracts simple PDF literal text', () => {
    const text = extractPdfTextFromBuffer(Buffer.from('%PDF\nBT (Hello PDF invoice) Tj ET'))
    expect(text).toContain('Hello PDF invoice')
  })

  test('extracts text from a FlateDecode-compressed PDF stream (the common case)', () => {
    // Nearly every PDF produced by Word/LaTeX/Chrome compresses content streams
    // with zlib. The old regex-on-raw-bytes parser found zero Tj/TJ operators
    // there and fell back to dumping ASCII noise from the binary — garbage in,
    // garbage embedded. This is a minimal real-shape PDF.
    const pdf = makeFlatePdf([
      'BT /F1 12 Tf (Invoice Total: Rp 250.000) Tj ET',
      'BT /F1 12 Tf [(Pay) (ment due)] TJ ET',
    ])
    const text = extractPdfTextFromBuffer(pdf)
    expect(text).toContain('Invoice Total: Rp 250.000')
    expect(text).toContain('Payment due')
  })

  test('hex-string PDF text operators are decoded', () => {
    // PDFs also encode text show operators as <hex> Tj using the font's
    // 2-byte CID codes for ASCII (common with pdfTeX).
    const pdf = Buffer.from('%PDF-1.4\nBT <00480065006c006c006f> Tj ET')
    const text = extractPdfTextFromBuffer(pdf)
    expect(text).toContain('Hello')
  })

  test('an UNCOMPRESSED stream with text operators is used directly, never inflate', () => {
    // The `else` for a stream the dict does not mark FlateDecode. Some writers omit the
    // filter, so the content is plain text already; the test-operators regex is what
    // accepts it. It must yield the text rather than being dropped.
    const content = 'BT /F1 12 Tf (Uncompressed stream body) Tj ET'
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from(`1 0 obj\n<< /Length ${content.length} >>\nstream\n`, 'latin1'),
      Buffer.from(content, 'latin1'),
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ])
    expect(extractPdfTextFromBuffer(pdf)).toContain('Uncompressed stream body')
  })

  test('an uncompressed stream with NO text operators is still tried as zlib', () => {
    // The other half of that `else`: no Tj/TJ operators means the bytes may be
    // compressed after all (a writer that omitted `/Filter`), so inflate is attempted
    // opportunistically. Here the payload IS deflate, just unlabelled, and it must come
    // back as text -- otherwise the reader silently loses a whole page.
    const content = 'BT /F1 12 Tf (Unlabelled deflate body) Tj ET'
    const compressed = zlib.deflateSync(Buffer.from(content, 'latin1'))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from(`1 0 obj\n<< /Length ${compressed.length} >>\nstream\n`, 'latin1'),
      compressed,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ])
    expect(extractPdfTextFromBuffer(pdf)).toContain('Unlabelled deflate body')
  })

  test('a stream LABELLED FlateDecode but holding garbage is skipped, not thrown', () => {
    // `/Filter /FlateDecode` with bytes that are not zlib at all -- a truncated download
    // or a producer bug. inflateSync throws, the catch swallows it, and the stream
    // contributes nothing. The reader must still process the OTHER streams rather than
    // aborting the whole document.
    const good = 'BT /F1 12 Tf (Second stream survives) Tj ET'
    const goodZ = zlib.deflateSync(Buffer.from(good, 'latin1'))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from('1 0 obj\n<< /Length 8 /Filter /FlateDecode >>\nstream\n', 'latin1'),
      Buffer.from('\x00\x01not-zlib', 'latin1'),
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
      Buffer.from(`2 0 obj\n<< /Length ${goodZ.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      goodZ,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ])
    const text = extractPdfTextFromBuffer(pdf)
    expect(text).toContain('Second stream survives')
    // And nothing from the corrupt stream leaked in as noise.
    expect(text).not.toContain('not-zlib')
  })

  test('hex Tj handles BOTH the 2-byte CID and the 1-byte ASCII encodings', () => {
    // PDF hex strings come in two shapes and the decoder picks between them on a
    // heuristic: if every EVEN-indexed byte is 0x00 it is 2-byte CID (the high byte of
    // each pair), otherwise the bytes are plain ASCII. Getting only the CID branch right
    // would silently mangle every pdfTeX file that emits one byte per character.
    const twoByte = Buffer.from('%PDF-1.4\nBT <00480065006c006c006f> Tj ET')
    expect(extractPdfTextFromBuffer(twoByte)).toContain('Hello')

    const oneByte = Buffer.from('%PDF-1.4\nBT <48656c6c6f> Tj ET')
    expect(extractPdfTextFromBuffer(oneByte)).toContain('Hello')

    // The heuristic is ALL-or-nothing: one non-zero even byte switches the whole string
    // to the 1-byte branch, so only the printable characters survive.
    const mixed = Buffer.from('%PDF-1.4\nBT <00480065FF> Tj ET')
    expect(extractPdfTextFromBuffer(mixed)).toBe('He')

    // An ODD number of hex digits is not a byte string at all and must yield nothing
    // rather than a half-decoded character.
    expect(extractPdfTextFromBuffer(Buffer.from('%PDF-1.4\nBT <414> Tj ET'))).toBe('')
  })

  test('DECLARED EQUIVALENT: forcing the 1-byte branch offline changes nothing', () => {
    // A control forcing `looksTwoByte` to FALSE produced no failing test, while forcing it
    // to TRUE did (the 2-byte branch reads odd bytes, turning <48656c6c6f> into 'el'
    // instead of 'Hello'). The asymmetry is because the 1-byte branch is a SUPERSET in
    // effect: applying it to a genuine CID string still yields the printable ASCII, so the
    // heuristic only has to protect the CID case. Declared rather than counted twice.
    const twoByte = Buffer.from('%PDF-1.4\nBT <00480065006c006c006f> Tj ET')
    expect(extractPdfTextFromBuffer(twoByte)).toContain('Hello')
  })

  test('DECLARED EQUIVALENT: dropping isFlate still works, via the opportunistic inflate', () => {
    // `const isFlate = /FlateDecode/.test(dict)` chooses the TRY path, not the outcome. A
    // control forcing it false produced no failing test, because the uncompressed `else`
    // then runs: the text-operator regex misses on compressed bytes and the opportunistic
    // `inflateSync` succeeds anyway. That redundancy IS the design -- the comment says the
    // fallback exists for writers that omit the filter or whose dict slice is missed. The
    // dict check is a fast path so the common case never pays for a failed inflate.
    const pdf = makeFlatePdf(['BT /F1 12 Tf (Flate route intact) Tj ET'])
    expect(extractPdfTextFromBuffer(pdf)).toContain('Flate route intact')
  })

  test('never returns binary noise when a PDF yields no text', () => {
    // A scanned/image-only PDF must NOT fall back to dumping raw ASCII bytes —
    // that garbage was being embedded and poisoned retrieval.
    const noise = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
      Buffer.from('\x00\x01\x02\x03junk\x7f\x80\xff'),
    ])
    const text = extractPdfTextFromBuffer(noise)
    expect(text).toBe('')
  })

  test('multi-stream PDFs: resumption past endstream does not match its inner stream', () => {
    // Regression: the stream walker used to resume scanning at the START of
    // 'endstream', so the regex matched the 'stream' INSIDE that keyword and
    // every subsequent body offset was garbage — 0 of 500+ streams inflated on
    // a real 300-page book PDF (329 chars of header noise instead of ~1.1M).
    const page1 = 'BT (First page body text) Tj ET'
    const page2 = 'BT (Second page body text) Tj ET'
    const comp1 = zlib.deflateSync(Buffer.from(page1, 'latin1'))
    const comp2 = zlib.deflateSync(Buffer.from(page2, 'latin1'))
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.from(`1 0 obj\n<< /Length ${comp1.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      comp1,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
      Buffer.from(`2 0 obj\n<< /Length ${comp2.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      comp2,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ])
    const text = extractPdfTextFromBuffer(pdf)
    expect(text).toContain('First page body text')
    expect(text).toContain('Second page body text')
  })

  test('extracts DOCX XML text from a stored zip', () => {
    const zip = makeStoredZip({
      'word/document.xml': '<w:document><w:t>Hello</w:t><w:t>DOCX</w:t></w:document>',
    })
    expect(extractDocxTextFromBuffer(zip)).toContain('Hello DOCX')
  })

  test('extracts XLSX shared strings and sheet values from a stored zip', () => {
    const zip = makeStoredZip({
      'xl/sharedStrings.xml': '<sst><si><t>SKU-902</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>7900</v></c></row></sheetData></worksheet>',
    })
    const text = extractXlsxTextFromBuffer(zip)
    expect(text).toContain('SKU-902')
    expect(text).toContain('7900')
  })
})

/**
 * Build a minimal but structurally real PDF whose page content stream is
 * zlib-compressed and referenced from a page object — the shape every modern
 * PDF producer emits.
 */
function makeFlatePdf(contentOperators: string[]): Buffer {
  const content = contentOperators.join('\n')
  const compressed = zlib.deflateSync(Buffer.from(content, 'latin1'))

  const objects: string[] = []
  // 1: Catalog, 2: Pages, 3: Page, 4: Contents stream, 5: Font
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>'
  objects[4] = `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`
  objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  let out = Buffer.from('%PDF-1.4\n')
  const offsets: number[] = [0]
  for (let i = 1; i <= 5; i += 1) {
    offsets[i] = out.length
    let body: Buffer
    if (i === 4) {
      body = Buffer.concat([
        Buffer.from(`${i} 0 obj\n`, 'latin1'),
        Buffer.from(objects[i], 'latin1'),
        compressed,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ])
    } else {
      body = Buffer.from(`${i} 0 obj\n${objects[i]}\nendobj\n`, 'latin1')
    }
    out = Buffer.concat([out, body])
  }
  const xrefStart = out.length
  let xref = 'xref\n0 6\n0000000000 65535 f \n'
  for (let i = 1; i <= 5; i += 1) {
    xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  }
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return Buffer.concat([out, Buffer.from(xref, 'latin1')])
}

function makeStoredZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = Buffer.from(content)
    const crc = 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(0, 8)
    dir.writeUInt16LE(0, 10)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(data.length, 20)
    dir.writeUInt32LE(data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt32LE(offset, 42)
    central.push(dir, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...central, end])
}
