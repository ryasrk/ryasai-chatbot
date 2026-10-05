/**
 * The question in the corpus's other language, for a retrieval that came back insufficient.
 *
 * WHY (failure audit, 2026-10-05): the cross-language bridge is a 39-entry synonym table (query-expansion.ts) and a
 * 384-dimension multilingual MiniLM embedding. Chunk-level recall for cross-language questions was 83.3% against 98.6%
 * for same-language ones, and every cross-language failure of the final run (q151, q166, q167, and q186's second hop)
 * was an English question over an Indonesian document or the reverse — each of them a second-pass turn. Translating the
 * question and searching with it is the standard remedy (question translation, Multilingual RAG, arXiv 2504.03616).
 *
 * Called on the SECOND pass only, so a turn whose first retrieval was sufficient pays nothing. One short call, no
 * reasoning (constants.ts STRUCTURED_PURPOSES). `RAG_TRANSLATE_ON_MISS=false` turns it off. Any failure returns null:
 * retrieval must not fail because a helper call did.
 */
const SYSTEM =
  'Translate the user question for a document search. If it is in Indonesian, translate it into English; otherwise ' +
  'translate it into Indonesian. Keep names, codes, numbers and document titles as they are. Do not answer. ' +
  'Reply with the translated question only.'

export async function translateForRetrieval(question: string): Promise<string | null> {
  if (process.env.RAG_TRANSLATE_ON_MISS === 'false') return null
  try {
    const { getRoleLlmConfig } = await import('@/lib/llm-config')
    const { chatOnce } = await import('@/lib/llm-client')
    const cfg = await getRoleLlmConfig('keyword')
    if (!cfg) return null
    const raw = String(await chatOnce(cfg, [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }], 0, 'query-translate'))
    const translated = raw.trim().replace(/^["'`]+|["'`]+$/g, '').trim()
    // A reply that is empty, the question itself, or far longer than a question is not a translation to search with.
    if (!translated || translated.length > question.length * 3 + 40) return null
    if (translated.toLowerCase() === question.trim().toLowerCase()) return null
    return translated
  } catch {
    return null
  }
}
