/**
 * Head-to-head: our pipeline vs a standard vector-RAG baseline, on the SAME corpus,
 * the SAME questions and the SAME judge.
 *
 * WHY A BASELINE AND NOT JUST OUR NUMBER. "Our RAGAS score is 0.87" says nothing — 0.87
 * relative to what? A retrieval number is only meaningful against an alternative measured
 * under identical conditions. The baseline is the industry default: embed the query, take
 * the top-k by cosine similarity, stuff them into the prompt, generate. That is what
 * LangChain/LlamaIndex ship out of the box and what a naive "vector RAG" deployment does.
 *
 * WHAT MAKES THE COMPARISON FAIR, and each of these was a decision:
 *   - same corpus (the org's real chunks, same extraction and repair pipeline)
 *   - same questions (LLM-generated paraphrases, not hand-written by whoever is being
 *     evaluated — a question set written by the author of one system is not evidence)
 *   - same k, same answer prompt, same generation model
 *   - same JUDGE, and the judge is a DIFFERENT model family from the generator, so
 *     self-preference bias cannot favour either side
 *   - both sides get the same candidate budget, so the comparison is about RANKING and
 *     CONTEXT ASSEMBLY rather than about who was allowed to look at more text
 */
import { writeFileSync } from 'node:fs'
import { db } from '@/lib/db'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { getRoleLlmConfig, getLlmRuntimeConfig } from '@/lib/llm-config'
import { chatOnce } from '@/lib/llm-client'
import { retrieveRelevantChunks } from '@/lib/rag-retrieval'
import { embedTexts } from '@/lib/embeddings'
import { scoreFaithfulness, scoreAnswerRelevance, scoreContextPrecision, scoreContextRecall } from './rag-eval'
import type { LlmRuntimeConfig } from '@/lib/llm-config'

export interface CompareRow {
  id: string
  question: string
  expected: string
  ours: { answer: string; citations: string[]; latencyMs: number }
  baseline: { answer: string; citations: string[]; latencyMs: number }
  judge: {
    ours: { faithfulness: number; answerRelevance: number; contextPrecision: number; contextRecall: number }
    baseline: { faithfulness: number; answerRelevance: number; contextPrecision: number; contextRecall: number }
  }
}

const ANSWER_PROMPT = (evidence: string, q: string) =>
  `Answer the question using ONLY the evidence below. Answer in one short sentence. ` +
  `If the evidence does not contain the answer, say you do not have that information.\n\n` +
  `Evidence:\n${evidence}\n\nQuestion: ${q}`

export async function runComparison(args: {
  orgId: string
  questions: Array<{ id: string; question: string; expectedAnswer: string }>
  topK: number
  judge: { baseUrl: string; apiKey: string; model: string }
}): Promise<CompareRow[]> {
  enterWithOrg(args.orgId)
  const judge: LlmRuntimeConfig = {
    provider: 'OPENAI_COMPATIBLE',
    baseUrl: args.judge.baseUrl,
    apiKey: args.judge.apiKey,
    model: args.judge.model,
  } as LlmRuntimeConfig
  const gen = await getLlmRuntimeConfig()
  if (!gen) throw new Error('no generation config')
  const embedCfg = await (await import('@/lib/embeddings')).getEmbeddingRuntimeConfig()
  if (!embedCfg) throw new Error('no embedding config')

  // The whole corpus, pre-embedded once, for the baseline's cosine search. Embeddings come
  // from the running model so both sides see identical vectors.
  const all = await db.documentChunk.findMany({
    where: { document: { status: 'ready', isEnabled: true } },
    select: { id: true, content: true, document: { select: { name: true } } },
  })
  const baselineVecs = new Map<string, number[]>()
  const BATCH = 32
  for (let i = 0; i < all.length; i += BATCH) {
    const slice = all.slice(i, i + BATCH)
    const vecs = await embedTexts(embedCfg, slice.map((c) => c.content.slice(0, 2000)))
    slice.forEach((c, j) => { if (vecs[j]) baselineVecs.set(c.id, vecs[j]) })
  }

  const rows: CompareRow[] = []
  for (const item of args.questions) {
    // ---- OURS: the shipped pipeline (intent pipeline -> lexical-first fusion -> rerank) ----
    const t0 = Date.now()
    const ours = await retrieveRelevantChunks({ query: item.question, topK: args.topK })
    const oursMs = Date.now() - t0
    const oursEvidence = ours.chunks.map((c, i) => `[${i + 1}] ${c.content.slice(0, 600)}`).join('\n\n')
    const oursAnswer = String(await chatOnce(gen, [{ role: 'user', content: ANSWER_PROMPT(oursEvidence, item.question) }], 0, 'compare')).trim()

    // ---- BASELINE: standard vector RAG — cosine top-k, no lexical leg, no fusion ----
    const t1 = Date.now()
    const [qv] = await embedTexts(embedCfg, [item.question])
    const scored = all
      .map((c) => {
        const v = baselineVecs.get(c.id)
        if (!v || !qv) return { c, sim: -1 }
        let dot = 0, na = 0, nb = 0
        for (let i = 0; i < v.length; i++) { dot += v[i] * qv[i]; na += v[i] * v[i]; nb += qv[i] * qv[i] }
        return { c, sim: dot / (Math.sqrt(na) * Math.sqrt(nb) || 1) }
      })
      .sort((a, b) => b.sim - a.sim)
      .slice(0, args.topK)
    const baseMs = Date.now() - t1
    const baseEvidence = scored.map((s, i) => `[${i + 1}] ${s.c.content.slice(0, 600)}`).join('\n\n')
    const baseAnswer = String(await chatOnce(gen, [{ role: 'user', content: ANSWER_PROMPT(baseEvidence, item.question) }], 0, 'compare')).trim()

    // ---- SAME JUDGE, BOTH SIDES ----
    // The real signatures take the QUESTION first and the config last — matched here rather
    // than assumed, because a silently-wrong argument order would return a plausible number.
    const judgeCfg = judge
    const j = async (answer: string, contexts: string[]) => ({
      faithfulness: await scoreFaithfulness(item.question, answer, contexts.join('\n\n'), judgeCfg),
      answerRelevance: await scoreAnswerRelevance(item.question, answer, judgeCfg),
      contextPrecision: await scoreContextPrecision(item.question, contexts.join('\n\n'), judgeCfg),
      contextRecall: await scoreContextRecall(item.question, item.expectedAnswer, contexts.join('\n\n'), judgeCfg),
    })

    rows.push({
      id: item.id,
      question: item.question,
      expected: item.expectedAnswer,
      ours: { answer: oursAnswer, citations: ours.chunks.map((c) => c.documentName), latencyMs: oursMs },
      baseline: { answer: baseAnswer, citations: scored.map((s) => s.c.document.name), latencyMs: baseMs },
      judge: {
        ours: await j(oursAnswer, ours.chunks.map((c) => c.content)),
        baseline: await j(baseAnswer, scored.map((s) => s.c.content)),
      },
    })
    console.log(`  judged ${rows.length}/${args.questions.length}`)
  }
  return rows
}

export function summarize(rows: CompareRow[], side: 'ours' | 'baseline') {
  // A judged mean ONLY: unjudged samples (NaN, from a failed or rate-limited judge call) are
  // excluded and counted. Measured the hard way — a 429 on the judge produced a full table of
  // exactly 0.500 on both sides, which reads as "mediocre" rather than "not measured".
  const mean = (f: (r: CompareRow) => number) => {
    const vals = rows.map(f).filter((v) => Number.isFinite(v))
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : Number.NaN
  }
  const unjudged = (f: (r: CompareRow) => number) => rows.length - rows.map(f).filter((v) => Number.isFinite(v)).length
  return {
    n: rows.length,
    faithfulness: mean((r) => r.judge[side].faithfulness),
    answerRelevance: mean((r) => r.judge[side].answerRelevance),
    contextPrecision: mean((r) => r.judge[side].contextPrecision),
    contextRecall: mean((r) => r.judge[side].contextRecall),
    latencyMs: mean((r) => r[side].latencyMs),
    unjudged: unjudged((r) => r.judge[side].faithfulness),
  }
}
