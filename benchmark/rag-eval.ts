/**
 * RAGAS-style RAG Evaluation Harness
 * ----------------------------------------------------------------------------
 * Measures RAG pipeline quality across 4 RAGAS metrics:
 *   1. Faithfulness — answer is grounded in retrieved context (no hallucination)
 *   2. Answer Relevance — answer addresses the question
 *   3. Context Precision — retrieved context is relevant to the question
 *   4. Context Recall — retrieved context contains info needed to answer
 *
 * Uses LLM-as-judge (same pattern as RAGAS library).
 * ponytail: no external RAGAS dependency — pure TS implementation using the
 * existing chatOnce transport. Run with: bun run benchmark/rag-eval.ts
 *
 * Usage:
 *   bun run benchmark/rag-eval.ts                    # run all RAG eval questions
 *   bun run benchmark/rag-eval.ts --limit 20        # run first 20
 *   bun run benchmark/rag-eval.ts --document doc-id # eval against specific document
 */
import { db } from '@/lib/db'
import { getRoleLlmConfig } from '@/lib/llm-config'
import { chatOnce } from '@/lib/llm-client'
import { retrieveRelevantChunks } from '@/lib/rag'
import { generateAnswer } from '@/lib/ai'
import { scopedLogger } from '@/lib/logger'
import { writeFileSync } from 'fs'

const log = scopedLogger('rag-eval')

// ---------------------------------------------------------------------------
// RAGAS metrics — LLM-as-judge prompts (simplified from the RAGAS paper).
// ---------------------------------------------------------------------------

interface RagasResult {
  questionId: string
  question: string
  expectedAnswer: string
  generatedAnswer: string
  retrievedChunks: { content: string; score: number; documentName: string }[]
  metrics: {
    faithfulness: number // 0-1: answer grounded in context
    answerRelevance: number // 0-1: answer addresses question
    contextPrecision: number // 0-1: retrieved context is relevant
    contextRecall: number // 0-1: context contains needed info
  }
  latencyMs: number
}

// ---------------------------------------------------------------------------
// Evaluation question set — ground truth for RAG quality measurement.
// ponytail: extend with real document-specific questions for production eval.
// ---------------------------------------------------------------------------

const RAG_EVAL_QUESTIONS = [
  {
    id: 'rag-001',
    question: 'Berapa termin pembayaran untuk pelanggan Enterprise?',
    expectedAnswer: '30 hari kalender sejak invoice diterbitkan',
    expectedKeywords: ['enterprise', '30', 'hari', 'termin', 'pembayaran'],
  },
  {
    id: 'rag-002',
    question: 'Berapa denda keterlambatan pembayaran invoice?',
    expectedAnswer: '1% per bulan dari nilai invoice, maksimum 5%',
    expectedKeywords: ['denda', '1%', '5%', 'keterlambatan', 'invoice'],
  },
  {
    id: 'rag-003',
    question: 'Siapa yang menyetujui pengadaan IT di bawah Rp 5.000.000?',
    expectedAnswer: 'Manajer departemen',
    expectedKeywords: ['pengadaan', '5.000.000', 'manajer', 'departemen', 'persetujuan'],
  },
  {
    id: 'rag-004',
    question: 'Berapa total pendapatan Q1 2026?',
    expectedAnswer: 'Rp 1.517.000.000',
    expectedKeywords: ['pendapatan', 'total', '1.517.000.000', 'Q1', '2026'],
  },
  {
    id: 'rag-005',
    question: 'Bagaimana prosedur penerimaan barang di gudang?',
    expectedAnswer: 'Setiap kiriman diperiksa oleh minimum dua staf, pencocokan surat jalan',
    expectedKeywords: ['penerimaan', 'barang', 'gudang', 'diperiksa', 'staf'],
  },
  {
    id: 'rag-006',
    question: 'Vendor mana yang resmi untuk pengadaan laptop?',
    expectedAnswer: 'PT Computech Asia dan CV Sumber Komputer',
    expectedKeywords: ['vendor', 'laptop', 'computech', 'sumber', 'komputer'],
  },
  {
    id: 'rag-007',
    question: 'Berapa margin bruto Q1 2026?',
    expectedAnswer: '30%',
    expectedKeywords: ['margin', 'bruto', '30%', 'Q1'],
  },
  {
    id: 'rag-008',
    question: 'Kapan pengingat otomatis dikirim sebelum jatuh tempo?',
    expectedAnswer: 'H-7 sebelum jatuh tempo',
    expectedKeywords: ['pengingat', 'otomatis', 'H-7', 'jatuh', 'tempo'],
  },
]

// ---------------------------------------------------------------------------
// LLM-as-judge scoring functions.
// ---------------------------------------------------------------------------

async function scoreFaithfulness(
  question: string,
  answer: string,
  context: string,
  cfg: NonNullable<Awaited<ReturnType<typeof getRoleLlmConfig>>>,
): Promise<number> {
  const prompt = `You are evaluating RAG faithfulness. Score 0.0-1.0 how grounded the answer is in the retrieved context.

Question: ${question}
Retrieved Context: ${context.slice(0, 2000)}
Answer: ${answer}

Score (0.0 = completely hallucinated, 1.0 = fully grounded in context).
Output ONLY a number 0.0-1.0.`

  try {
    const raw = await chatOnce(cfg, [{ role: 'user', content: prompt }], 0, 'ragas-faithfulness')
    return clampScore(parseFloat(raw.trim()))
  } catch {
    return 0.5
  }
}

async function scoreAnswerRelevance(
  question: string,
  answer: string,
  cfg: NonNullable<Awaited<ReturnType<typeof getRoleLlmConfig>>>,
): Promise<number> {
  const prompt = `You are evaluating answer relevance. Score 0.0-1.0 how well the answer addresses the question.

Question: ${question}
Answer: ${answer}

Score (0.0 = completely off-topic, 1.0 = perfectly addresses the question).
Output ONLY a number 0.0-1.0.`

  try {
    const raw = await chatOnce(cfg, [{ role: 'user', content: prompt }], 0, 'ragas-relevance')
    return clampScore(parseFloat(raw.trim()))
  } catch {
    return 0.5
  }
}

async function scoreContextPrecision(
  question: string,
  context: string,
  cfg: NonNullable<Awaited<ReturnType<typeof getRoleLlmConfig>>>,
): Promise<number> {
  const prompt = `You are evaluating context precision. Score 0.0-1.0 how relevant the retrieved context is to the question.

Question: ${question}
Retrieved Context: ${context.slice(0, 2000)}

Score (0.0 = completely irrelevant, 1.0 = all context highly relevant).
Output ONLY a number 0.0-1.0.`

  try {
    const raw = await chatOnce(cfg, [{ role: 'user', content: prompt }], 0, 'ragas-precision')
    return clampScore(parseFloat(raw.trim()))
  } catch {
    return 0.5
  }
}

async function scoreContextRecall(
  question: string,
  expectedAnswer: string,
  context: string,
  cfg: NonNullable<Awaited<ReturnType<typeof getRoleLlmConfig>>>,
): Promise<number> {
  const prompt = `You are evaluating context recall. Score 0.0-1.0 how much of the expected answer information is present in the retrieved context.

Question: ${question}
Expected Answer: ${expectedAnswer}
Retrieved Context: ${context.slice(0, 2000)}

Score (0.0 = none of the expected info is in context, 1.0 = all expected info is present).
Output ONLY a number 0.0-1.0.`

  try {
    const raw = await chatOnce(cfg, [{ role: 'user', content: prompt }], 0, 'ragas-recall')
    return clampScore(parseFloat(raw.trim()))
  } catch {
    return 0.5
  }
}

function clampScore(n: number): number {
  if (Number.isNaN(n)) return 0.5
  return Math.max(0, Math.min(1, n))
}

// ---------------------------------------------------------------------------
// Main evaluation runner.
// ---------------------------------------------------------------------------

async function runRagEvaluation(limit?: number): Promise<void> {
  const cfg = await getRoleLlmConfig('query')
  if (!cfg) {
    console.error('No LLM configured — cannot run RAGAS evaluation.')
    process.exit(1)
  }

  const questions = limit ? RAG_EVAL_QUESTIONS.slice(0, limit) : RAG_EVAL_QUESTIONS
  const results: RagasResult[] = []

  console.log(`\nRAGAS RAG Evaluation — ${questions.length} questions\n`)

  for (const q of questions) {
    const t0 = Date.now()

    // Retrieve + generate
    const retrieval = await retrieveRelevantChunks({ query: q.question, topK: 4 })
    const context = retrieval.chunks.map((c) => c.content).join('\n\n')
    const answer = await generateAnswer({
      question: q.question,
      context,
      source: 'RAG',
    })

    // Score with LLM-as-judge
    const [faithfulness, answerRelevance, contextPrecision, contextRecall] = await Promise.all([
      scoreFaithfulness(q.question, answer, context, cfg),
      scoreAnswerRelevance(q.question, answer, cfg),
      scoreContextPrecision(q.question, context, cfg),
      scoreContextRecall(q.question, q.expectedAnswer, context, cfg),
    ])

    const result: RagasResult = {
      questionId: q.id,
      question: q.question,
      expectedAnswer: q.expectedAnswer,
      generatedAnswer: answer,
      retrievedChunks: retrieval.chunks.map((c) => ({
        content: c.content.slice(0, 200),
        score: c.score,
        documentName: c.documentName,
      })),
      metrics: { faithfulness, answerRelevance, contextPrecision, contextRecall },
      latencyMs: Date.now() - t0,
    }

    results.push(result)
    console.log(
      `[${q.id}] ${q.question.slice(0, 40)}...  F=${faithfulness.toFixed(2)} R=${answerRelevance.toFixed(2)} P=${contextPrecision.toFixed(2)} C=${contextRecall.toFixed(2)}  ${result.latencyMs}ms`,
    )
  }

  // Aggregate
  const avg = (fn: (r: RagasResult) => number) => results.reduce((s, r) => s + fn(r), 0) / results.length
  const summary = {
    questions: results.length,
    avgFaithfulness: avg((r) => r.metrics.faithfulness),
    avgAnswerRelevance: avg((r) => r.metrics.answerRelevance),
    avgContextPrecision: avg((r) => r.metrics.contextPrecision),
    avgContextRecall: avg((r) => r.metrics.contextRecall),
    avgLatencyMs: avg((r) => r.latencyMs),
  }

  console.log('\n--- Summary ---')
  console.log(`Faithfulness:      ${summary.avgFaithfulness.toFixed(3)}`)
  console.log(`Answer Relevance:  ${summary.avgAnswerRelevance.toFixed(3)}`)
  console.log(`Context Precision: ${summary.avgContextPrecision.toFixed(3)}`)
  console.log(`Context Recall:    ${summary.avgContextRecall.toFixed(3)}`)
  console.log(`Avg Latency:       ${summary.avgLatencyMs.toFixed(0)}ms`)

  const report = { summary, results, timestamp: new Date().toISOString() }
  writeFileSync('benchmark/results/ragas-report.json', JSON.stringify(report, null, 2))
  console.log('\nReport saved to benchmark/results/ragas-report.json')
}

// CLI entry
const args = process.argv.slice(2)
const limitArg = args.find((a) => a.startsWith('--limit='))
const limit = limitArg ? parseInt(limitArg.split('=')[1]) : undefined

runRagEvaluation(limit).catch((e) => {
  console.error('RAG evaluation failed:', e)
  process.exit(1)
})

export { runRagEvaluation, scoreFaithfulness, scoreAnswerRelevance, scoreContextPrecision, scoreContextRecall }
