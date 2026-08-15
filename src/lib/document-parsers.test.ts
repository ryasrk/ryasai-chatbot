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
