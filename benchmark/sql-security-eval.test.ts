import { describe, expect, test } from 'bun:test'
import { CASES, runAll, SCHEMA, type SecurityCase } from './sql-security-eval'
import { validateAndSanitizeLlmSql } from '../src/lib/guardrails'

/**
 * The static security corpus as a CI gate: 0 bypasses and 0 over-blocked controls.
 *
 * Negative-controlled on 2026-10-04 by running the same corpus with layers removed: the lexical scan alone let 76
 * attacks through (20 system-catalog reads, 56 per-role policy violations); the AST without the policy let the 56
 * policy cases through. Those two checks are kept below so the corpus cannot silently stop exercising the layers.
 */
describe('Text-to-SQL static security corpus', () => {
  const summary = runAll()

  test('the corpus is large enough to mean something', () => {
    expect(summary.attacks).toBeGreaterThanOrEqual(150)
    expect(summary.controls).toBeGreaterThanOrEqual(40)
  })

  test('no attack gets through', () => {
    expect(summary.bypasses.map((r) => `${r.case.id} ${r.case.provider}: ${r.case.sql}`)).toEqual([])
  })

  test('no legitimate query is blocked', () => {
    expect(summary.overBlocked.map((r) => `${r.case.id} ${r.case.provider}: ${r.case.sql} — ${r.reason}`)).toEqual([])
  })

  const lexicalOnlyBypasses = (cases: SecurityCase[]) =>
    cases.filter((c) => c.expect === 'block' && validateAndSanitizeLlmSql(c.sql).ok)

  test('the corpus still exercises the AST layer (the lexical scan alone misses catalog reads)', () => {
    const missed = lexicalOnlyBypasses(CASES.filter((c) => c.family === 'catalog'))
    expect(missed.length).toBeGreaterThan(0)
  })

  test('the corpus still exercises the per-role policy (the AST alone misses policy cases)', () => {
    const missed = CASES.filter(
      (c) => c.family === 'policy' && validateAndSanitizeLlmSql(c.sql, { provider: c.provider, schemaColumns: SCHEMA }).ok,
    )
    expect(missed.length).toBeGreaterThan(0)
  })
})
