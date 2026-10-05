import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { buildPgOrQuery } from './rag-fts'

// The mocked suites (rag-fts*.test.ts) can only check the string; whether Postgres PARSES it, and what it matches, needs
// a real server. Skips when none answers — the unit suite runs without a database (ci.yml).
let client: Client | null = null

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url?.startsWith('postgres')) return
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 1_500 })
  try {
    await c.connect()
    client = c
  } catch {
    client = null
  }
})

afterAll(async () => {
  await client?.end()
})

const CHUNK = 'The HagueAccord of 2016 was an important advance in the global war on drugs.'
const QUESTION = ['accord', 'discussed', 'context', 'advances', 'against', 'drug', 'trade', 'established', '2016']

describe('buildPgOrQuery against a real Postgres', () => {
  test('a question whose words are not ALL in the chunk still matches it (the AND query did not)', async () => {
    if (!client) return
    const { rows } = await client.query<{ any_word: boolean; every_word: boolean }>(
      `SELECT to_tsvector('simple', $1 || ' hague accord') @@ to_tsquery('simple', $2) AS any_word,
              to_tsvector('simple', $1 || ' hague accord') @@ plainto_tsquery('simple', $3) AS every_word`,
      [CHUNK, buildPgOrQuery(QUESTION), QUESTION.join(' ')],
    )
    expect(rows[0]).toEqual({ any_word: true, every_word: false })
  })

  test('operator characters in the input never reach to_tsquery as operators', async () => {
    if (!client) return
    const hostile = ['a & b', 'c | d', '!e', 'f:g', 'h <-> i', "x' OR 1=1 --", '(', '|', '&', 'ünïcödé', '東京']
    const q = buildPgOrQuery(hostile)
    // Parses (no syntax error) and is exactly an OR of plain lexemes.
    const { rows } = await client.query<{ q: string }>(`SELECT to_tsquery('simple', $1)::text AS q`, [q])
    expect(rows[0].q).toBe(q.split(' | ').map((t) => `'${t}'`).join(' | '))
  })
})
