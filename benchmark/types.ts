export type BenchmarkCategory =
  | 'simple_select'
  | 'aggregation'
  | 'time_series'
  | 'join_two_table'
  | 'join_multi_table'
  | 'subquery'
  | 'join_or_subquery'
  | 'filtering'
  | 'sorting_limit'
  | 'geo_queries'
  | 'multi_hop'
  | 'complex_analytics'
  | 'robustness_typo'
  | 'robustness_paraphrase'
  | 'cross_source_hybrid'
  | 'long_session'
  | 'cross_session'
  | 'source_toggle'

export type BenchmarkDifficulty = 'easy' | 'medium' | 'hard'

export interface BenchmarkQuestion {
  id: string
  category: BenchmarkCategory
  difficulty: BenchmarkDifficulty
  question: string
  groundTruthSql: string
  expectedAnswerContains: string[]
  expectedColumns: string[]
  integrationId: string
  tags: string[]
}

/**
 * Hybrid question — needs BOTH a database integration and document knowledge.
 * The DB half is scored like a normal question; the knowledge half is scored
 * by expectedKnowledgeKeywords presence in the final answer. The hybrid
 * runner additionally records routing behavior (answered vs clarified vs
 * looped), because the failure mode this pins is: with BOTH sources
 * configured, the router/agentic loop used to spin in clarification loops
 * instead of answering.
 */
export interface HybridBenchmarkQuestion extends BenchmarkQuestion {
  category: 'cross_source_hybrid'
  expectedKnowledgeKeywords: string[]
}

// ---------------------------------------------------------------------------
// Conversational scenarios (session runner)
// ---------------------------------------------------------------------------

/** What a single turn inside a long session expects. */
export interface SessionTurn {
  question: string
  /** Tokens the answer must contain (ground-truth numbers/names). */
  expectContains?: string[]
  /** Tokens whose presence is a failure (contamination / fabrication). */
  expectNotContains?: string[]
  /** Which source this turn primarily needs. */
  kind: 'sql' | 'knowledge' | 'hybrid' | 'chat'
  /** Marks that this turn refers to an earlier turn's subject ("mereka", "dia"). */
  followsUpOn?: string
}

/** Multi-turn scenario inside ONE session — history grows, follow-ups resolve. */
export interface LongSessionScenario {
  id: string
  category: 'long_session'
  difficulty: BenchmarkDifficulty
  description: string
  turns: SessionTurn[]
}

/** Multi-SESSION scenario — facts must carry over (or fail honestly). */
export interface CrossSessionScenario {
  id: string
  category: 'cross_session'
  difficulty: BenchmarkDifficulty
  description: string
  /** Each entry runs in its own chat session, in order. */
  sessions: Array<{
    sessionKey: string
    turns: SessionTurn[]
    /** Tokens the answer should recall from a PREVIOUS session (memory probe). */
    memoryProbes?: string[]
  }>
}

/** Expected pipeline behavior classification per step. */
export type ToggleExpectedBehavior =
  | 'answers-db'        // answered with DB data
  | 'answers-knowledge' // answered citing documents
  | 'answers-chat'      // plain LLM chat answer
  | 'refuses-db'        // honestly declines to query (SQL unavailable)
  | 'no-doc-citation'   // answers without fabricating document content

/** A toggle-scenario step: either flip tools or ask (and classify the answer). */
export type ToggleStep =
  | { action: 'set-tools'; tools: { sql: boolean; rag: boolean; restApi?: boolean } }
  | { action: 'restore-tools' }
  | {
      action: 'ask'
      question: string
      expectBehavior: ToggleExpectedBehavior
      expectContains?: string[]
      expectNotContains?: string[]
      followsUpOn?: string
      note?: string
    }

/** Tool-availability reaction scenario — honesty under source toggling. */
export interface ToggleScenario {
  id: string
  category: 'source_toggle'
  difficulty: BenchmarkDifficulty
  description: string
  steps: ToggleStep[]
}
