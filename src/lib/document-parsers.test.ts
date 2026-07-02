import { describe, expect, test } from 'bun:test'
import { extractDocxTextFromBuffer, extractPdfTextFromBuffer, extractXlsxTextFromBuffer } from './document-parsers'

describe('document parsers', () => {
  test('extracts simple PDF literal text', () => {
    const text = extractPdfTextFromBuffer(Buffer.from('%PDF\nBT (Hello PDF invoice) Tj ET'))
    expect(text).toContain('Hello PDF invoice')
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
