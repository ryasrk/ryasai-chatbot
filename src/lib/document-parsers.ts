import zlib from 'node:zlib'

interface ZipEntry {
  name: string
  data: Buffer
}

// ---------------------------------------------------------------------------
// PDF text extraction
// -----------------------------------------------------------------------------
// A PDF is a container of objects; page text lives in content streams that are
// zlib-compressed (FlateDecode) in virtually every PDF produced since 2000.
// The old parser ran text-show regexes over the RAW file bytes, so it only
// ever matched uncompressed (rare) streams and otherwise fell back to dumping
// printable ASCII from the binary — garbage that then got chunked, embedded,
// and poisoned retrieval. This extractor:
//   1. walks `stream … endstream` spans,
//   2. inflates the ones whose owning object declares /FlateDecode (and tries
//      inflate anyway on declaration-less spans — cheap, safe),
//   3. decodes the three text-show encodings: (literal) Tj, [(a)(b)] TJ, and
//      <hex> Tj (2-byte CID ASCII, pdfTeX style),
//   4. returns '' when a PDF yields no real text (image-only scan) instead of
//      binary noise — the caller marks the doc as a placeholder.
// -----------------------------------------------------------------------------

export function extractPdfTextFromBuffer(buffer: Buffer): string {
  const chunks: string[] = []

  let sawStream = false
  for (const decoded of iteratePdfContentStreams(buffer)) {
    sawStream = true
    chunks.push(...extractTextOperators(decoded))
  }

  // Degenerate PDFs (hand-written tests, some minimal generators) carry text
  // operators at the top level with no stream object at all — scan the raw
  // bytes for the same operators when no stream produced anything.
  if (!sawStream) {
    chunks.push(...extractTextOperators(buffer.toString('latin1')))
  }

  const text = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text) return text
  // No text operators anywhere → image-only/scanned PDF. Return EMPTY so the
  // caller stores a placeholder instead of embedding binary noise.
  return ''
}

/**
 * Extract the three text-show operator families from one decoded content
 * stream: (literal) Tj / ' / ", [(a)(b)…] TJ arrays, and <hex> Tj/TJ.
 */
function extractTextOperators(decoded: string): string[] {
  const out: string[] = []

  const literals = [...decoded.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:Tj|'|")/g)]
    .map((m) => cleanPdfText(decodePdfLiteral(m[1])))
  if (literals.length > 0) out.push(literals.join('\n'))

  const arrays = [...decoded.matchAll(/\[((?:\([^()]*\)\s*|-?\d+\s*)+)\]\s*TJ/g)]
    .map((m) =>
      [...m[1].matchAll(/\(([^()]*)\)/g)]
        .map((s) => cleanPdfText(decodePdfLiteral(s[1])))
        .join(''),
    )
    .filter(Boolean)
  if (arrays.length > 0) out.push(arrays.join('\n'))

  const hexes = [...decoded.matchAll(/<([0-9A-Fa-f\s]+)>\s*(?:Tj|TJ)/g)]
    .map((m) => decodePdfHexString(m[1]))
    .filter(Boolean)
  if (hexes.length > 0) out.push(hexes.join('\n'))

  return out
}

/** Yield each content-stream body, inflated when compressed. */
function* iteratePdfContentStreams(buffer: Buffer): Generator<string> {
  const latin = buffer.toString('latin1')
  const streamRe = /stream\r?\n?/g
  let m: RegExpExecArray | null
  while ((m = streamRe.exec(latin)) !== null) {
    const bodyStart = m.index + m[0].length
    const endIdx = latin.indexOf('endstream', bodyStart)
    if (endIdx < 0) break
    // The declared /Length can overhang the real data; find endstream first,
    // then trim trailing EOL before it.
    let bodyEnd = endIdx
    while (bodyEnd > bodyStart && /\r?\n/.test(latin[bodyEnd - 1])) bodyEnd -= 1
    const raw = buffer.subarray(bodyStart, bodyEnd)
    // ponytail: skip past the WHOLE 'endstream' keyword — resuming at its start
    // makes the regex match the 'stream' inside 'endstream' itself and every
    // subsequent body offset is garbage (0 of 500+ streams inflated on real PDFs).
    streamRe.lastIndex = endIdx + 'endstream'.length

    const dictStart = latin.lastIndexOf('<<', bodyStart)
    const dict = dictStart >= 0 ? latin.slice(dictStart, bodyStart) : ''
    const isFlate = /FlateDecode/.test(dict)

    let text = ''
    if (isFlate) {
      try { text = zlib.inflateSync(raw).toString('latin1') } catch { /* corrupt */ }
    } else {
      // Uncompressed stream — inspect for text operators directly, but also
      // opportunistically try inflate: some writers omit the filter or the dict
      // slice misses it. inflate of plain text fails fast.
      if (/\)\s*Tj|\]\s*TJ|>\s*TJ/.test(raw.toString('latin1'))) {
        text = raw.toString('latin1')
      } else {
        try { text = zlib.inflateSync(raw).toString('latin1') } catch { /* not zlib */ }
      }
    }
    if (text) yield text
  }
}

/** Decode PDF literal escapes: \n \r \t \b \f \( \) \\ \ddd (octal). */
function decodePdfLiteral(s: string): string {
  return s
    .replace(/\\([0-7]{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\([()\\])/g, '$1')
}

/** Decode <hex> Tj strings: 2-byte BE codes (00XX = ASCII) or 1-byte ASCII hex. */
function decodePdfHexString(hex: string): string {
  const clean = hex.replace(/\s+/g, '')
  if (!clean || clean.length % 2 !== 0) return ''
  const bytes = Buffer.from(clean, 'hex')
  // Heuristic used by every lightweight extractor: if every odd byte (high
  // byte of each pair) is 0x00, treat as 2-byte CID ASCII.
  const looksTwoByte = bytes.length >= 2 && bytes.length % 2 === 0 &&
    bytes.filter((_, i) => i % 2 === 0).every((b) => b === 0)
  let out = ''
  if (looksTwoByte) {
    for (let i = 1; i < bytes.length; i += 2) out += String.fromCharCode(bytes[i])
  } else {
    for (const b of bytes) out += b >= 32 && b < 127 ? String.fromCharCode(b) : ''
  }
  return out.trim()
}

function cleanPdfText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
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
