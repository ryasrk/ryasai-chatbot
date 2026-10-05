import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { gluedWordVariants, GLUED_WORDS_SQL } from './glued-words'

// The SQL twin of gluedWordVariants runs inside Postgres when `tsv` is computed, so only a real Postgres can show the two
// agree (regex dialects differ: POSIX classes there, \p{…} here). The unit suite needs no database (ci.yml), so this
// skips when none answers; locally DATABASE_URL points at the dev database.
const CASES = [
  'the U.S. CleanAirActAmendments last century',
  'for olderAmericans to leave a bequest',
  'Reef inAustralia is the worldÕs most popular',
  'HarvardÕs first doctorate; UNESCOÕs Bright Horizons',
  'an HTMLParser class with the emerg- ing markets',
  'accounting for 20% of GDPgrowth this century',
  'JavaScript and iPhone',
  'The Clean Air Act Amendments of 1990, a well-known co-operative, NASA; Õun is Estonian',
  '',
]

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

describe('GLUED_WORDS_SQL against a real Postgres', () => {
  test('produces the same variants as gluedWordVariants', async () => {
    if (!client) return // no database reachable: nothing to compare against
    for (const text of CASES) {
      const { rows } = await client.query<{ v: string }>(`SELECT ${GLUED_WORDS_SQL('t.content')} AS v FROM (VALUES ($1::text)) AS t(content)`, [text])
      expect({ text, v: rows[0].v }).toEqual({ text, v: gluedWordVariants(text) })
    }
  })

  test('the variants make a glued phrase findable through the simple tsvector', async () => {
    if (!client) return
    const { rows } = await client.query<{ hit: boolean; before: boolean }>(
      `SELECT to_tsvector('simple', t.content || ' ' || ${GLUED_WORDS_SQL('t.content')}) @@ plainto_tsquery('simple', 'clean air act amendments') AS hit,
              to_tsvector('simple', t.content) @@ plainto_tsquery('simple', 'clean air act amendments') AS before
       FROM (VALUES ('the U.S. CleanAirActAmendments last century'::text)) AS t(content)`,
    )
    expect(rows[0]).toEqual({ hit: true, before: false })
  })
})
