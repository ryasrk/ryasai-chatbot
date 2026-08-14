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
import { getRoleLlmConfig, type LlmRuntimeConfig } from '@/lib/llm-config'
import { chatOnce } from '@/lib/llm-client'
import { retrieveRelevantChunks } from '@/lib/rag'
import { generateAnswer } from '@/lib/ai'
import { postLangfuseScore } from '@/lib/observability'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { readFileSync } from 'fs'
import { writeFileSync } from 'fs'

// ---------------------------------------------------------------------------
// Separate judge config (RAGAS_JUDGE_* env) — defaults to the query-role LLM.
//
// WHY: when the judge is the same model+endpoint that generated the answer,
// scores inflate (self-preference bias) and the eval stops detecting anything.
// Point RAGAS_JUDGE_BASE_URL / _KEY / _MODEL at a DIFFERENT provider/model
// (even a cheaper one) and the numbers become meaningful.
// ---------------------------------------------------------------------------
async function getJudgeConfig(): Promise<LlmRuntimeConfig | null> {
  const baseUrl = process.env.RAGAS_JUDGE_BASE_URL
  const apiKey = process.env.RAGAS_JUDGE_KEY
  const model = process.env.RAGAS_JUDGE_MODEL
  if (baseUrl && apiKey && model) {
    return {
      provider: process.env.RAGAS_JUDGE_PROVIDER?.toUpperCase() === 'ANTHROPIC_COMPATIBLE'
        ? 'ANTHROPIC_COMPATIBLE'
        : 'OPENAI_COMPATIBLE',
      baseUrl,
      apiKey,
      model,
    } as LlmRuntimeConfig
  }
  return getRoleLlmConfig('query')
}

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

async function runRagEvaluation(limit?: number, ciMode: boolean = false): Promise<void> {
  const cfg = await getRoleLlmConfig('query')
  if (!cfg) {
    console.error('No LLM configured — cannot run RAGAS evaluation.')
    process.exit(1)
  }

  // Separate judge when configured; otherwise the same model (flagged in the
  // report so nobody mistakes a self-judged run for an independent one).
  const judge = await getJudgeConfig()
  const judgeIsGenerator = !process.env.RAGAS_JUDGE_BASE_URL

  // Org context — retrieval + generation are org-scoped; without this the eval
  // ran unscoped (empty or cross-tenant results depending on the fallback).
  const orgId = process.env.EVAL_ORG_ID
  if (orgId) enterWithOrg(orgId)

  // Question set: --golden=<file> (generated by golden-set.ts) or the
  // built-in 8. The golden file is the meaningful sample size (40+).
  const goldenPath = process.argv.find((a) => a.startsWith('--golden='))?.split('=')[1]
  let questions: Array<{ id: string; question: string; expectedAnswer: string; expectedKeywords?: string[] }>
  if (goldenPath) {
    const parsed = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
      questions: Array<{ id: string; question: string; expectedAnswer: string; expectedKeywords?: string[] }>
    }
    questions = parsed.questions
    console.log(`Loaded ${questions.length} golden questions from ${goldenPath}`)
  } else {
    questions = RAG_EVAL_QUESTIONS
    console.warn('⚠ Using the 8 built-in questions — sample size is not statistically meaningful.')
    console.warn('  Generate a real set: bun run benchmark/golden-set.ts --org=<orgId> --out=benchmark/results/golden.json')
  }
  if (limit) questions = questions.slice(0, limit)

  const results: RagasResult[] = []

  console.log(`\nRAGAS RAG Evaluation — ${questions.length} questions (judge ${judgeIsGenerator ? '= generator (SELF-JUDGED)' : 'independent'})\n`)

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
      scoreFaithfulness(q.question, answer, context, judge ?? cfg),
      scoreAnswerRelevance(q.question, answer, judge ?? cfg),
      scoreContextPrecision(q.question, context, judge ?? cfg),
      scoreContextRecall(q.question, q.expectedAnswer, context, judge ?? cfg),
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

  // Post RAGAS scores to Langfuse if configured (fire-and-forget, never blocks)
  postLangfuseScore({ name: 'faithfulness', value: summary.avgFaithfulness })
  postLangfuseScore({ name: 'answer_relevance', value: summary.avgAnswerRelevance })
  postLangfuseScore({ name: 'context_precision', value: summary.avgContextPrecision })
  postLangfuseScore({ name: 'context_recall', value: summary.avgContextRecall })

  console.log('\n--- Summary ---')
  console.log(`Faithfulness:      ${summary.avgFaithfulness.toFixed(3)}`)
  console.log(`Answer Relevance:  ${summary.avgAnswerRelevance.toFixed(3)}`)
  console.log(`Context Precision: ${summary.avgContextPrecision.toFixed(3)}`)
  console.log(`Context Recall:    ${summary.avgContextRecall.toFixed(3)}`)
  console.log(`Avg Latency:       ${summary.avgLatencyMs.toFixed(0)}ms`)

  const report = {
    summary,
    results,
    timestamp: new Date().toISOString(),
    meta: {
      questionCount: results.length,
      questionSource: goldenPath ?? 'builtin-8',
      judgeIndependent: !judgeIsGenerator,
      judgeModel: judge?.model ?? 'unconfigured',
      orgId: orgId ?? '(unscoped)',
    },
  }
  writeFileSync('benchmark/results/ragas-report.json', JSON.stringify(report, null, 2))
  console.log('\nReport saved to benchmark/results/ragas-report.json')

  if (ciMode) checkCIThresholds(summary)
}

function checkCIThresholds(summary: {
  avgFaithfulness: number
  avgAnswerRelevance: number
  avgContextPrecision: number
  avgContextRecall: number
}): void {
  const thresholds = {
    faithfulness: Number(process.env.RAGAS_MIN_FAITHFULNESS ?? 0.85),
    answerRelevance: Number(process.env.RAGAS_MIN_ANSWER_RELEVANCE ?? 0.80),
    contextPrecision: Number(process.env.RAGAS_MIN_CONTEXT_PRECISION ?? 0.80),
    contextRecall: Number(process.env.RAGAS_MIN_CONTEXT_RECALL ?? 0.80),
  }

  const failures: string[] = []
  if (summary.avgFaithfulness < thresholds.faithfulness) {
    failures.push(`Faithfulness ${summary.avgFaithfulness.toFixed(3)} < ${thresholds.faithfulness}`)
  }
  if (summary.avgAnswerRelevance < thresholds.answerRelevance) {
    failures.push(`Answer Relevance ${summary.avgAnswerRelevance.toFixed(3)} < ${thresholds.answerRelevance}`)
  }
  if (summary.avgContextPrecision < thresholds.contextPrecision) {
    failures.push(`Context Precision ${summary.avgContextPrecision.toFixed(3)} < ${thresholds.contextPrecision}`)
  }
  if (summary.avgContextRecall < thresholds.contextRecall) {
    failures.push(`Context Recall ${summary.avgContextRecall.toFixed(3)} < ${thresholds.contextRecall}`)
  }

  if (failures.length > 0) {
    console.error('\n❌ CI threshold check FAILED:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }

  console.log('\n✅ CI threshold check passed')
}

// CLI entry
if (import.meta.main) {
  const args = process.argv.slice(2)
  const limitArg = args.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : undefined
  const ciMode = args.includes('--ci')

  runRagEvaluation(limit, ciMode).catch((e) => {
    console.error('RAG evaluation failed:', e)
    process.exit(1)
  })
}

export { runRagEvaluation, checkCIThresholds, scoreFaithfulness, scoreAnswerRelevance, scoreContextPrecision, scoreContextRecall }
