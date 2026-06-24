/**
 * RAG utilities — shared by document upload + retrieval routes.
 * ----------------------------------------------------------------------------
 * PRAGMATIC SANDBOX IMPLEMENTATION:
 * The original spec (§3.3) calls for BGE-M3 dense embeddings stored in
 * ChromaDB with hybrid BM25 + dense retrieval. Neither BGE-M3 nor ChromaDB
 * are available in this sandbox, so we implement a lightweight keyword-
 * overlap scorer that preserves the same API surface (chunk + keywords).
 * The retrieval function in `search/route.ts` documents this clearly.
 */

/** Indonesian + English stopword set (lowercased). */
export const STOPWORDS = new Set<string>([
  // Indonesian
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'atau',
  'ini', 'itu', 'adalah', 'akan', 'tidak', 'juga', 'dalam', 'agar', 'karena',
  'oleh', 'sebagai', 'para', 'telah', 'namun', 'bisa', 'dapat', 'harus',
  'kepada', 'tentang', 'setelah', 'sebelum', 'antara', 'hingga', 'serta',
  'tetapi', 'apa', 'bagaimana', 'kapan', 'mana', 'siapa', 'berapa', 'dimana',
  'the', 'and', 'for', 'with', 'that', 'this', 'are', 'was', 'were', 'have',
  'has', 'had', 'not', 'but', 'from', 'into', 'onto', 'over', 'under',
  // common short words
  'a', 'an', 'of', 'in', 'to', 'is', 'it', 'on', 'as', 'at', 'by', 'be',
  'do', 'if', 'or', 'we', 'you', 'they', 'he', 'she', 'my', 'our',
])

/** Tokenize a string into retrieval terms: lowercase, >=4 chars, no stopwords, no digits-only. */
export function tokenize(text: string): string[] {
  if (!text) return []
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const out: string[] = []
  const seen = new Set<string>()
  for (const w of words) {
    if (w.length < 4) continue
    if (STOPWORDS.has(w)) continue
    if (/^\d+$/.test(w)) continue
    if (seen.has(w)) continue
    seen.add(w)
    out.push(w)
  }
  return out
}

/**
 * Extract top-N keywords from a chunk of text by term frequency.
 * Returns a comma-separated string suitable for the `keywords` column.
 */
export function extractKeywords(text: string, topN = 8): string {
  if (!text) return ''
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const freq = new Map<string, number>()
  for (const w of words) {
    if (w.length < 4) continue
    if (STOPWORDS.has(w)) continue
    if (/^\d+$/.test(w)) continue
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
  return sorted.map(([w]) => w).join(',')
}

/**
 * Split text into semantic-ish chunks on double-newlines.
 * Filters empty chunks and trims whitespace.
 */
export function chunkText(content: string): string[] {
  if (!content) return []
  return content
    .split(/\n\n+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
}

/** Detect document type from filename. Falls back to 'txt'. */
export function detectDocType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.xlsx')) return 'xlsx'
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.txt')) return 'txt'
  // fallback: try last extension
  const idx = lower.lastIndexOf('.')
  if (idx >= 0) return lower.slice(idx + 1)
  return 'txt'
}

/**
 * Extract text from an uploaded File.
 *
 * For .md/.txt: read as UTF-8.
 * For .pdf/.docx/.xlsx: there is no binary parser in this sandbox, so we
 *   attempt `file.text()` and detect whether the result is mostly printable.
 *   If it looks like garbage binary, we store a synthetic placeholder.
 *
 * Returns `{ text, isPlaceholder }`.
 */
export async function extractFileText(
  file: File,
): Promise<{ text: string; isPlaceholder: boolean }> {
  const name = file.name
  const size = file.size
  const type = detectDocType(name)

  // Pure-text formats: read directly.
  if (type === 'txt' || type === 'md') {
    try {
      const text = await file.text()
      return { text: text ?? '', isPlaceholder: false }
    } catch {
      return {
        text: `[Text document: ${name}, ${size} bytes. Read failed.]`,
        isPlaceholder: true,
      }
    }
  }

  // Binary formats: try text(), validate printable ratio.
  try {
    const raw = await file.text()
    if (raw && raw.length > 0) {
      const sample = raw.slice(0, 4096)
      const printable = (sample.match(/[\p{L}\p{N}\p{P}\s]/gu) ?? []).length
      const ratio = printable / Math.max(sample.length, 1)
      if (ratio > 0.85) {
        // Looks like real text (some PDFs embed text streams).
        return { text: raw, isPlaceholder: false }
      }
    }
  } catch {
    /* fall through to placeholder */
  }

  return {
    text: `[Binary document: ${name}, ${size} bytes. Parsed content placeholder.]`,
    isPlaceholder: true,
  }
}
