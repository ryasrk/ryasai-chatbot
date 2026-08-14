import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('rag')
import {
  extractDocxTextFromBuffer,
  extractPdfTextFromBuffer,
  extractXlsxTextFromBuffer,
} from '@/lib/document-parsers'
import {
  RAG_CHUNK_SIZE,
  RAG_CHUNK_OVERLAP,
} from '@/lib/constants'

const DEFAULT_MAX_CHUNK_CHARS = RAG_CHUNK_SIZE
const DEFAULT_OVERLAP_CHARS = RAG_CHUNK_OVERLAP

// Hard cap on extracted text — enforced before regex/rebuild work so a 50MB file
// can't balloon into millions of in-memory chunk strings.
export const MAX_EXTRACTED_TEXT_CHARS = 2_000_000

export interface ParentDocChunk {
  content: string
  contextPrefix: string
}

const PARENT_DOC_CHILD_SIZE = Number(process.env.PARENT_DOC_CHILD_SIZE ?? 512)
const PARENT_DOC_WINDOW = Number(process.env.PARENT_DOC_WINDOW ?? 2048)

export function chunkText(
  content: string,
  options: { maxChars?: number; overlapChars?: number; maxChunks?: number } = {},
): string[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHUNK_CHARS
  const overlapChars = Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, maxChars)
  const maxChunks = options.maxChunks ?? Infinity
  if (!content) return []
  // ponytail: stop building chunks once maxChunks is reached — avoids materializing
  // tens of thousands of chunk strings only to slice them down to 500 afterwards.
  const chunks: string[] = []
  for (const block of splitStructuralBlocks(content)) {
    for (const chunk of splitLongChunk(block, maxChars, overlapChars)) {
      if (chunks.length >= maxChunks) return chunks
      chunks.push(chunk)
    }
  }
  return chunks
}

/**
 * Structure-aware block splitting: heading-delimited sections and tables become
 * their own blocks BEFORE size-based chunking, so a chunk never straddles two
 * sections and a table never gets cut mid-row from its header.
 *
 * Recognized (cheap, format-agnostic — PDF/DOCX extractors lose real heading
 * markup, so plain-text heuristics are all we get):
 *   - Markdown/ASCII headings: lines starting with #, or ALL-CAPS/Title Case
 *     short lines ending without sentence punctuation, numbered "1."/"1.1"
 *   - Tables: ≥2 consecutive lines containing a tab or 2+ spaces-around-pipes,
 *     or markdown pipe tables
 *
 * Ceiling: a heading detector can misfire on aggressive ALL-CAPS prose; the
 * section heuristic requires short + no-terminal-punctuation, which excludes
 * most sentences. Structural misfires cost a chunk boundary, not content.
 */
export function splitStructuralBlocks(content: string): string[] {
  const lines = content.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let inTable = false

  const flush = () => {
    if (current.length > 0) {
      const text = current.join('\n').trim()
      if (text) blocks.push(text)
      current = []
    }
  }

  for (const line of lines) {
    // Blank line = paragraph boundary — flush so paragraphs stay separate chunks
    // (this is what the old split(/\n\n+/) did; structure awareness must not
    // merge what used to be distinct).
    if (!line.trim()) {
      flush()
      inTable = false
      continue
    }

    const isTableLine = isTableRow(line)
    if (isTableLine && !inTable) {
      flush()
      inTable = true
    } else if (!isTableLine && inTable) {
      flush()
      inTable = false
    }

    if (isHeadingLine(line)) {
      flush()
      inTable = false
      current.push(line)
      flush()
      continue
    }

    current.push(line)
  }
  flush()
  return blocks
}

function isHeadingLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  // Markdown heading
  if (/^#{1,6}\s+\S/.test(trimmed)) return true
  // Numbered/outline section markers: "1. Foo", "1.1 Foo", "A. Foo", "BAB II Foo".
  // Single letters REQUIRE the dot (outline style) — without it, any capitalized
  // first word ("Para one.") would match the bare [A-Z] alternative.
  if (/^(?:\d+(?:\.\d+)*\.|[A-Z]\.|\bBAB\b\s+[IVXLC\d]+)\s+\S/.test(trimmed) && trimmed.length <= 80 && !/[.!?]$/.test(trimmed)) return true
  // ALL-CAPS short line without terminal punctuation
  if (trimmed.length <= 80 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed) && !/[.!?;,]$/.test(trimmed)) return true
  return false
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  // Markdown pipe table row (| a | b |) including separator rows (|---|---|)
  if (/^\|.*\|$/.test(trimmed)) return true
  // Tab-separated with ≥1 tab and at least 2 non-empty cells
  if (trimmed.includes('\t')) {
    const cells = trimmed.split('\t').filter((c) => c.trim().length > 0)
    if (cells.length >= 2) return true
  }
  return false
}

/**
 * Parent-document chunking: small child chunks for precise embedding,
 * each carrying a surrounding parent window as contextPrefix for retrieval recall.
 * ponytail: simple sliding window — not paragraph-aware. Upgrade to semantic
 * boundary detection if retrieval precision needs it.
 */
export function chunkTextParentDoc(
  content: string,
  options: { childSize?: number; parentWindow?: number; maxChunks?: number } = {},
): ParentDocChunk[] {
  const childSize = options.childSize ?? PARENT_DOC_CHILD_SIZE
  const parentWindow = options.parentWindow ?? PARENT_DOC_WINDOW
  const maxChunks = options.maxChunks ?? Infinity
  if (!content || content.trim().length === 0) return []

  const words = content.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []

  const chunks: ParentDocChunk[] = []
  let pos = 0

  // ponytail: early-out once maxChunks is reached (same reasoning as chunkText).
  while (pos < words.length && chunks.length < maxChunks) {
    const childWords = words.slice(pos, pos + estimateWordCount(childSize))
    const childContent = childWords.join(' ')
    if (childContent.length === 0) break

    const halfWindow = Math.floor(estimateWordCount(parentWindow) / 2)
    const parentStart = Math.max(0, pos - halfWindow)
    const parentEnd = Math.min(words.length, pos + childWords.length + halfWindow)
    const parentContent = words.slice(parentStart, parentEnd).join(' ')

    chunks.push({ content: childContent, contextPrefix: parentContent + '\n\n' })
    pos += childWords.length
  }

  return chunks
}

function estimateWordCount(charCount: number): number {
  return Math.max(1, Math.ceil(charCount / 5))
}

function splitLongChunk(content: string, maxChars: number, overlapChars: number): string[] {
  if (content.length <= maxChars) return [content]

  const chunks: string[] = []
  let current = ''
  for (const word of content.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxChars && current) {
      chunks.push(current)
      const overlap = trailingWordsWithin(current, overlapChars)
      current = overlap ? `${overlap} ${word}` : word
    } else {
      current = next
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function trailingWordsWithin(content: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  const words = content.split(/\s+/).filter(Boolean)
  const kept: string[] = []
  let length = 0
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index]
    const nextLength = length + word.length + (kept.length > 0 ? 1 : 0)
    if (nextLength > maxChars) break
    kept.unshift(word)
    length = nextLength
  }
  return kept.join(' ')
}

export function detectDocType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.txt')) return 'txt'
  const idx = lower.lastIndexOf('.')
  if (idx >= 0) return lower.slice(idx + 1)
  return 'txt'
}

export async function extractFileText(
  file: File,
): Promise<{ text: string; isPlaceholder: boolean }> {
  const name = file.name
  const size = file.size
  const type = detectDocType(name)

  if (type === 'txt' || type === 'md') {
    try {
      const text = await file.text()
      return { text: text ?? '', isPlaceholder: false }
    } catch (e) {
      log.warn('extractFileText read failed', { error: e instanceof Error ? e.message : String(e) })
      return { text: `[Text document: ${name}, ${size} bytes. Read failed.]`, isPlaceholder: true }
    }
  }

  const binary = Buffer.from(await file.arrayBuffer())
  if (type === 'pdf') {
    const text = extractPdfTextFromBuffer(binary)
    if (text) return { text: limitExtractedText(text), isPlaceholder: false }
  }
  if (type === 'docx') {
    const text = extractDocxTextFromBuffer(binary)
    if (text) return { text: limitExtractedText(text), isPlaceholder: false }
  }
  if (type === 'xlsx') {
    const text = extractXlsxTextFromBuffer(binary)
    if (text) return { text: limitExtractedText(text), isPlaceholder: false }
  }

  try {
    const raw = await file.text()
    if (raw && raw.length > 0) {
      const sample = raw.slice(0, 4096)
      const printable = (sample.match(/[\p{L}\p{N}\p{P}\s]/gu) ?? []).length
      const ratio = printable / Math.max(sample.length, 1)
      if (ratio > 0.85) {
        return { text: raw, isPlaceholder: false }
      }
    }
  } catch {
    /* fall through to placeholder */
  }

  return { text: `[Binary document: ${name}, ${size} bytes. Parsed content placeholder.]`, isPlaceholder: true }
}

function limitExtractedText(text: string): string {
  // slice before the normalize regex so huge extractions don't get regex'd in full
  return text.slice(0, MAX_EXTRACTED_TEXT_CHARS).replace(/\s+\n/g, '\n').trim()
}
