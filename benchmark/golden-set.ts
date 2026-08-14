/**
 * Golden-set generator — builds evaluation questions from the org's actual
 * documents, so the eval measures THIS corpus instead of 8 hardcoded
 * questions about documents that may not exist.
 *
 * Two layers:
 *   1. EXTRACTIVE (deterministic, free): sentence-level facts lifted from
 *      chunks — recall/precision ground truth by construction.
 *   2. LLM (optional): richer paraphrased questions per chunk.
 *
 * Usage: bun run benchmark/golden-set.ts --org <orgId> [--limit 40] [--out file]
 */
import { db } from '@/lib/db'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { STOPWORDS } from '@/lib/rag'
import { writeFileSync } from 'fs'

export interface GoldenQuestion {
  id: string
  question: string
  expectedAnswer: string
  expectedKeywords: string[]
  documentId: string
  documentName: string
  origin: 'extractive' | 'llm'
}

const MIN_CHUNK_CHARS = 120
const MAX_CHUNK_CHARS = 600
const PER_DOC_LIMIT = 4

/**
 * Extractive question from a declarative sentence: the sentence is the expected
 * answer; keywords are its informative tokens. Question phrasing is templated
 * (bilingual mix) so the eval also exercises the intent router's language mix.
 */
function extractiveQuestion(
  index: number,
  docId: string,
  docName: string,
  sentence: string,
): GoldenQuestion | null {
  const clean = sentence.replace(/\s+/g, ' ').trim()
  if (clean.length < 40 || clean.length > 320) return null
  // Declarative only — no questions, no headings, no list fragments.
  if (!/[.!?]$/.test(clean)) return null
  if (/^(how|what|why|when|where|who|bagaimana|apa|mengapa|kapan|dimana|siapa|berapa)\b/i.test(clean)) return null
  if (clean.split(/\s+/).length < 6) return null

  const keywords = clean
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s%]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    .slice(0, 6)
  if (keywords.length < 2) return null

  const templates = [
    `Menurut ${docName}, apa yang dikatakan tentang: ${clipSubject(clean)}?`,
    `What does ${docName} say about ${clipSubject(clean)}?`,
    `Berdasarkan dokumen, ${clipLead(clean)}`,
  ]
  const question = templates[index % templates.length]

  return {
    id: `gold-ext-${index}`,
    question,
    expectedAnswer: clean,
    expectedKeywords: keywords,
    documentId: docId,
    documentName: docName,
    origin: 'extractive',
  }
}

function clipSubject(sentence: string): string {
  return sentence.split(/[,;:]/)[0].slice(0, 120)
}

function clipLead(sentence: string): string {
  return sentence.charAt(0).toLowerCase() + sentence.slice(1, 100)
}

/** Build the extractive golden set for one org. Never calls an LLM. */
export async function generateExtractiveGoldenSet(args: {
  orgId: string
  limit?: number
}): Promise<GoldenQuestion[]> {
  enterWithOrg(args.orgId)
  const docs = await db.document.findMany({
    where: { status: 'ready', isEnabled: true },
    select: { id: true, name: true, contentText: true },
    take: 50,
  })

  const out: GoldenQuestion[] = []
  let index = 0
  for (const doc of docs) {
    let fromDoc = 0
    // Sentence-split on terminal punctuation followed by whitespace+capital.
    const sentences = doc.contentText.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    for (const s of sentences) {
      if (s.length < MIN_CHUNK_CHARS || s.length > MAX_CHUNK_CHARS) continue
      if (fromDoc >= PER_DOC_LIMIT) break
      const q = extractiveQuestion(index, doc.id, doc.name, s)
      if (!q) continue
      out.push(q)
      fromDoc += 1
      index += 1
      if (args.limit && out.length >= args.limit) return out
    }
  }
  return out
}

/** LLM-generated paraphrase questions (optional second layer). */
export async function generateLlmGoldenSet(args: {
  orgId: string
  limit?: number
}): Promise<GoldenQuestion[]> {
  const { getRoleLlmConfig } = await import('@/lib/llm-config')
  const { chatOnce } = await import('@/lib/llm-client')
  const cfg = await getRoleLlmConfig('query')
  if (!cfg) return []

  enterWithOrg(args.orgId)
  const chunks = await db.documentChunk.findMany({
    where: { document: { status: 'ready', isEnabled: true } },
    select: { id: true, content: true, documentId: true, document: { select: { name: true } } },
    take: args.limit ?? 20,
  })

  const out: GoldenQuestion[] = []
  for (const [i, chunk] of chunks.entries()) {
    try {
      const raw = await chatOnce(
        cfg,
        [
          {
            role: 'system',
            content:
              'You write evaluation questions for a retrieval system. Given a text passage, write ONE natural question (Indonesian or English, alternate) that this passage fully answers, plus the exact answer sentence. Output ONLY JSON: {"question":"...","answer":"..."}',
          },
          { role: 'user', content: chunk.content.slice(0, 1500) },
        ],
        0,
        'golden-set',
      )
      const cleaned = raw.replace(/```json?|```/g, '').trim()
      const parsed = JSON.parse(cleaned) as { question?: string; answer?: string }
      if (!parsed.question || !parsed.answer) continue
      out.push({
        id: `gold-llm-${i}`,
        question: parsed.question,
        expectedAnswer: parsed.answer,
        expectedKeywords: parsed.answer.toLowerCase().split(/\s+/).filter((w) => w.length >= 4).slice(0, 6),
        documentId: chunk.documentId,
        documentName: chunk.document.name,
        origin: 'llm',
      })
    } catch {
      // skip chunk on parse failure
    }
  }
  return out
}

// CLI entry
if (import.meta.main) {
  const args = process.argv.slice(2)
  const org = args.find((a) => a.startsWith('--org='))?.split('=')[1] ?? process.env.EVAL_ORG_ID
  const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '40', 10)
  const out = args.find((a) => a.startsWith('--out='))?.split('=')[1]
  const withLlm = args.includes('--llm')

  if (!org) {
    console.error('Usage: bun run benchmark/golden-set.ts --org=<orgId> [--limit=40] [--llm] [--out=file]')
    console.error('  (or set EVAL_ORG_ID)')
    process.exit(1)
  }

  const extractive = await generateExtractiveGoldenSet({ orgId: org, limit })
  let all = extractive
  if (withLlm) {
    const llmSet = await generateLlmGoldenSet({ orgId: org, limit: 15 })
    all = [...extractive, ...llmSet]
  }
  const json = JSON.stringify({ orgId: org, generatedAt: new Date().toISOString(), count: all.length, questions: all }, null, 2)
  if (out) {
    writeFileSync(out, json)
    console.log(`Wrote ${all.length} questions → ${out}`)
  } else {
    console.log(json)
  }
  process.exit(0)
}
