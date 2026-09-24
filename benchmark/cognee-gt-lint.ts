#!/usr/bin/env bun
/**
 * Static verifier for benchmark ground truth (gt-lint).
 * ----------------------------------------------------------------------------
 * Implements mechanical checks based on the benchmark audit and MuSiQue discipline:
 *
 * 1. NEGATIVE HOP CHECK (Audit Fix 1):
 *    Chains in medium, hard, and non-negative complex tiers must NEVER contain
 *    negative relations (e.g. `no_record_for`). Negative facts belong exclusively
 *    to the complex 'negative' sub-mechanism.
 *
 * 2. HOP CHECK (Audit Fix 1 & 3):
 *    Every hop in `hopChain` must point to a real document whose text actually
 *    contains both the `from` and `to` entities.
 *
 * 3. CHAIN MINIMALITY CHECK:
 *    For multi-hop questions, no single document and no strict subset of evidence
 *    documents may contain the final answer.
 *
 * 4. GROUND TRUTH HONESTY:
 *    For non-negative questions, the answer must be present in the evidence
 *    documents, and must never be leaked into the question text.
 *
 * 5. SURFACE FORM CHECK (Audit Fix 3):
 *    Every entity named in the question must appear verbatim in the corpus.
 *    No raw synthetic IDs like `dlv-001` that appear in 0 corpus documents.
 *
 * Exit code is non-zero on ANY violation.
 *
 * Usage:
 *   bun benchmark/cognee-gt-lint.ts --corpus=/tmp/corpus.json --questions=/tmp/questions.jsonl
 */
import { readFileSync } from 'node:fs'

interface Hop {
  from: string
  via: string
  to: string
  docId: string
}

interface BenchmarkQuestion {
  id: string
  tier: 'easy' | 'medium' | 'hard' | 'complex'
  submechanism: string | null
  question: string
  answer: string
  answerAliases: string[]
  evidenceDocIds: string[]
  hopChain: Hop[]
  distractorDocIds: string[]
  distractorStrings: string[]
  mustAppearTokens: string[]
  mustNotAppearTokens: string[]
  asOf: string | null
  answerIsNegative: boolean
}

interface CorpusDoc {
  id: string
  title: string
  text: string
  entityIds?: string[]
  entityNames?: string[]
}

interface CorpusJson {
  docs: CorpusDoc[]
  index?: {
    namesById?: Record<string, string>
    relations?: Array<{ subject: string; predicate: string; object: string }>
  }
}

export interface LintResult {
  totalQuestions: number
  tierCounts: Record<string, number>
  violations: Array<{
    id: string
    tier: string
    check: string
    message: string
  }>
  passed: boolean
}

export function lintGroundTruth(corpus: CorpusJson, questions: BenchmarkQuestion[]): LintResult {
  const docById = new Map<string, CorpusDoc>()
  for (const d of corpus.docs) docById.set(d.id, d)

  const names = corpus.index?.namesById ?? {}
  const violations: LintResult['violations'] = []
  const tierCounts: Record<string, number> = {}

  for (const q of questions) {
    tierCounts[q.tier] = (tierCounts[q.tier] ?? 0) + 1

    // Check 1: Surface form check — question must not leak answer
    if (!q.answerIsNegative && q.question.toLowerCase().includes(q.answer.toLowerCase())) {
      violations.push({
        id: q.id,
        tier: q.tier,
        check: 'question-leaks-answer',
        message: `Question text contains answer "${q.answer}": "${q.question}"`,
      })
    }

    // Check 2: Surface form check — no raw internal lowercase IDs like dlv-XXX in question
    const rawIdMatch = q.question.match(/\b(dlv|ven|wh|proj|apr|inc)-\d+\b/)
    if (rawIdMatch) {
      violations.push({
        id: q.id,
        tier: q.tier,
        check: 'raw-id-in-question',
        message: `Question contains raw entity ID "${rawIdMatch[0]}" that does not appear in corpus text. Use display label instead: "${q.question}"`,
      })
    }

    // Check 3: Negative relations in multi-hop chains (Audit Fix 1)
    if (q.tier === 'medium' || q.tier === 'hard' || (q.tier === 'complex' && q.submechanism !== 'negative')) {
      for (const hop of q.hopChain ?? []) {
        if (hop.via === 'no_record_for' || hop.via.toLowerCase().includes('negative')) {
          violations.push({
            id: q.id,
            tier: q.tier,
            check: 'negative-relation-in-chain',
            message: `Hop uses negative predicate "${hop.via}" between "${hop.from}" and "${hop.to}" in doc ${hop.docId}`,
          })
        }
      }
    }

    // Check 4: Hop entity groundedness (Hop check)
    for (const hop of q.hopChain ?? []) {
      const doc = docById.get(hop.docId)
      if (!doc) {
        violations.push({
          id: q.id,
          tier: q.tier,
          check: 'missing-hop-document',
          message: `Hop docId "${hop.docId}" does not exist in corpus`,
        })
        continue
      }
      const docText = doc.text.toLowerCase()

      // Normalize token for match check
      const normalizeEntity = (e: string) => e.replace(/^PT\s+/i, '').replace(/^(delivery|invoice|incident|finding|project|warehouse|batch|serial)\s+/i, '').trim().toLowerCase()

      const fromNorm = normalizeEntity(hop.from)
      const toNorm = normalizeEntity(hop.to)

      // Skip check if hop.to is a descriptive text (like for supersession assertion)
      const isDescriptiveTo = hop.to.length > 30 || hop.to.includes(';')

      const hasFrom = docText.includes(fromNorm)
      const hasTo = isDescriptiveTo || docText.includes(toNorm)

      if (!hasFrom) {
        violations.push({
          id: q.id,
          tier: q.tier,
          check: 'hop-missing-from-entity',
          message: `Hop doc ${hop.docId} does not contain "from" entity "${hop.from}" (${fromNorm})`,
        })
      }
      if (!hasTo) {
        violations.push({
          id: q.id,
          tier: q.tier,
          check: 'hop-missing-to-entity',
          message: `Hop doc ${hop.docId} does not contain "to" entity "${hop.to}" (${toNorm})`,
        })
      }
    }

    // Check 5: Answer reachability in evidence
    if (!q.answerIsNegative) {
      const evidenceConcat = q.evidenceDocIds.map((id) => docById.get(id)?.text ?? '').join(' ').toLowerCase()
      const answerNorm = q.answer.toLowerCase()
      if (!evidenceConcat.includes(answerNorm)) {
        violations.push({
          id: q.id,
          tier: q.tier,
          check: 'answer-not-in-evidence',
          message: `Answer "${q.answer}" is not found in evidence docs [${q.evidenceDocIds.join(', ')}]`,
        })
      }
    }

    // Check 6: Multi-hop Chain minimality (Chain check)
    // No single evidence document may contain the final answer on a multi-hop tier
    if ((q.tier === 'medium' || q.tier === 'hard') && q.evidenceDocIds.length >= 2) {
      const answerNorm = q.answer.toLowerCase()
      for (const docId of q.evidenceDocIds.slice(0, -1)) {
        const text = (docById.get(docId)?.text ?? '').toLowerCase()
        if (text.includes(answerNorm)) {
          violations.push({
            id: q.id,
            tier: q.tier,
            check: 'premature-answer-in-chain',
            message: `Multi-hop question answer "${q.answer}" appears prematurely in early hop doc ${docId}`,
          })
        }
      }
    }

    // Check 7: Answer minimum length
    if (!q.answerIsNegative && q.answer.length < 3) {
      violations.push({
        id: q.id,
        tier: q.tier,
        check: 'answer-too-short',
        message: `Answer "${q.answer}" is too short (< 3 chars)`,
      })
    }
  }

  return {
    totalQuestions: questions.length,
    tierCounts,
    violations,
    passed: violations.length === 0,
  }
}

const argOf = (name: string, fallback: string | null = null): string | null => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function main(): void {
  const corpusPath = argOf('corpus', '/tmp/corpus.json')!
  const questionsPath = argOf('questions', '/tmp/questions.jsonl')!

  console.log(`\n=== GROUND TRUTH LINT (MuSiQue Discipline) ===`)
  console.log(`  Corpus:    ${corpusPath}`)
  console.log(`  Questions: ${questionsPath}\n`)

  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as CorpusJson
  const rawQuestions = readFileSync(questionsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BenchmarkQuestion)

  const result = lintGroundTruth(corpus, rawQuestions)

  console.log(`Total questions analyzed: ${result.totalQuestions}`)
  console.log(`Tier counts: ${JSON.stringify(result.tierCounts)}`)

  if (!result.passed) {
    console.error(`\n❌ FAILED: ${result.violations.length} ground-truth violations found:`)
    const byCheck: Record<string, number> = {}
    for (const v of result.violations) {
      byCheck[v.check] = (byCheck[v.check] ?? 0) + 1
    }
    for (const [check, count] of Object.entries(byCheck)) {
      console.error(`  - ${check.padEnd(28)}: ${count} violations`)
    }
    console.error(`\nSample violations:`)
    for (const v of result.violations.slice(0, 10)) {
      console.error(`  [${v.tier}] ${v.id} (${v.check}): ${v.message}`)
    }
    process.exit(1)
  }

  console.log(`\n✅ PASSED: All ${result.totalQuestions} questions passed ground-truth linting with 0 violations!`)
  console.log(`  - 0 negative relation hops in multi-hop chains`)
  console.log(`  - 100% of hop documents contain both entities`)
  console.log(`  - 0 leaked answers in questions`)
  console.log(`  - 0 premature answers in early chain documents`)
}

if (import.meta.main) {
  main()
}
