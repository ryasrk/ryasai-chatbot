import zlib from 'node:zlib'

interface ZipEntry {
  name: string
  data: Buffer
}

export function extractPdfTextFromBuffer(buffer: Buffer): string {
  const raw = buffer.toString('latin1')
  const literals = [...raw.matchAll(/\(([^()]{2,500})\)\s*Tj/g)]
    .map((match) => cleanPdfText(match[1]))
  const arrays = [...raw.matchAll(/\[((?:\([^()]{1,200}\)\s*)+)\]\s*TJ/g)]
    .map((match) => [...match[1].matchAll(/\(([^()]*)\)/g)].map((m) => cleanPdfText(m[1])).join(''))
  const text = [...literals, ...arrays].join('\n').trim()
  if (text) return text
  return raw.replace(/[^\x20-\x7E\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export function extractDocxTextFromBuffer(buffer: Buffer): string {
  const entries = readZipEntries(buffer)
  return entries
    .filter((entry) => /^word\/(document|header|footer|footnotes|endnotes).*\.xml$/.test(entry.name))
    .map((entry) => extractXmlText(entry.data.toString('utf8')))
    .filter(Boolean)
    .join('\n\n')
}

export function extractXlsxTextFromBuffer(buffer: Buffer): string {
  const entries = readZipEntries(buffer)
  const sharedEntry = entries.find((entry) => entry.name === 'xl/sharedStrings.xml')
  const shared = sharedEntry ? extractXmlTexts(sharedEntry.data.toString('utf8')) : []
  return entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .map((entry) => extractSheetText(entry.data.toString('utf8'), shared))
    .filter(Boolean)
    .join('\n\n')
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const endOffset = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (endOffset < 0) return []
  const total = buffer.readUInt16LE(endOffset + 10)
  const centralOffset = buffer.readUInt32LE(endOffset + 16)
  const entries: ZipEntry[] = []
  let ptr = centralOffset
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) break
    const method = buffer.readUInt16LE(ptr + 10)
    const compressedSize = buffer.readUInt32LE(ptr + 20)
    const uncompressedSize = buffer.readUInt32LE(ptr + 24)
    const nameLen = buffer.readUInt16LE(ptr + 28)
    const extraLen = buffer.readUInt16LE(ptr + 30)
    const commentLen = buffer.readUInt16LE(ptr + 32)
    const localOffset = buffer.readUInt32LE(ptr + 42)
    const name = buffer.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8')
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const compressed = buffer.slice(dataStart, dataStart + compressedSize)
    let data = compressed
    if (method === 8) data = zlib.inflateRawSync(compressed)
    if (method === 0 || method === 8) {
      entries.push({ name, data: data.slice(0, uncompressedSize || data.length) })
    }
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function extractSheetText(xml: string, shared: string[]): string {
  const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
    const cells = [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => {
      const attrs = cell[1]
      const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ?? ''
      return attrs.includes('t="s"') ? shared[Number(value)] ?? value : decodeXml(value)
    })
    return cells.filter(Boolean).join('\t')
  })
  return rows.filter(Boolean).join('\n')
}

function extractXmlText(xml: string): string {
  return extractXmlTexts(xml).join(' ').replace(/\s+/g, ' ').trim()
}

function extractXmlTexts(xml: string): string[] {
  return [...xml.matchAll(/<[^:>]*:?t\b[^>]*>([\s\S]*?)<\/[^:>]*:?t>/g)]
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean)
}

function decodeXml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function cleanPdfText(value: string): string {
  return value.replace(/\\([()\\])/g, '$1').replace(/\\n/g, '\n').trim()
}
