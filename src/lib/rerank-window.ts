/**
 * The part of a chunk the LLM reranker is shown: the window that holds the most query words, not the opening.
 *
 * WHY (failure audit, 2026-10-05): the rerank prompt showed `content.slice(0, 300)`. Of 267 evidence quotes in the
 * eval corpus, 146 (55%) start after character 300 of their chunk — multi-hop 32 of 69 — so the reranker scored chunks
 * whose answer it could not see. Verified on q179: an insurance table chunk opens with its header and five fleet rows;
 * the JKT-02 row it was asked about is ~1,000 characters in, and the reranker endorsed the neighbouring chunk instead.
 * A query-biased extract is the classic remedy (Tombros & Sanderson, SIGIR 1998: readers judge relevance from it
 * without the full text). Deterministic and the same size, so no model call and about the same prompt.
 *
 * A window starts only at the chunk's start, a line or a sentence. Ties go to the EARLIEST start, so a chunk whose
 * opening is already the best match is shown exactly as before. A window that starts later is prefixed with the
 * chunk's first line (a heading or a table header), because a table row without its header is a list of bare values.
 */
import { tokenize } from '@/lib/rag-scoring'

export const RERANK_WINDOW_CHARS = 300
const HEADING_CHARS = 120

export function rerankWindow(text: string, query: string, size = RERANK_WINDOW_CHARS): string {
  if (text.length <= size) return text
  const wanted = new Set(tokenize(query))
  const opening = text.slice(0, size)
  if (wanted.size === 0) return opening

  // The lines shown with every later window: the first line (a heading) and, in a table, the column header.
  const lines = text.split('\n')
  const header = lines.find((l) => l.trimStart().startsWith('|'))
  const heading = lines[0].slice(0, HEADING_CHARS).trim()
  const contextWords = new Set(tokenize(`${heading} ${header?.slice(0, 200) ?? ''}`))
  // Query words visible in this window, counting the context lines every window is shown with — otherwise a heading
  // that repeats the query ("Insurance Coverage Limits") makes the opening win against the row that answers it.
  const score = (windowWords: Set<string>) => {
    let n = 0
    for (const w of wanted) if (contextWords.has(w) || windowWords.has(w)) n++
    return n
  }
  const starts = [0]
  for (const m of text.matchAll(/\n+|[.!?]\s+/g)) {
    const at = m.index! + m[0].length
    if (at < text.length) starts.push(at)
  }
  const scores = starts.map((start) => score(new Set(tokenize(text.slice(start, start + size)))))
  const max = Math.max(...scores)
  // The opening keeps its place on a tie: a chunk that was already shown well is shown exactly as before. Otherwise
  // the LATEST start that still reaches the best score, so the matched sentence or row leads the window instead of
  // being cut off at its end.
  if (scores[0] === max) return opening
  const best = starts[scores.lastIndexOf(max)]
  const window = text.slice(best, best + size)
  const context = [heading]
  if (window.trimStart().startsWith('|') && header && header !== lines[0] && !window.includes(header)) context.push(header.slice(0, 200).trim())
  return `${context.join('\n')}\n…\n${window}`
}
