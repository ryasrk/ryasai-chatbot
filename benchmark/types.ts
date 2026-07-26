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
