import { describe, expect, test } from 'bun:test'


describe('database selection — the enum contract', () => {
  // INCIDENT (MEASURED, 5 tries per variant on the same question):
  //   database named in a PROMPT list, with the real rule set present: 0/5 emitted
  //   database as a SCHEMA ENUM:                                        5/5 emitted
  // The prose version worked only while the prompt was short — once the full rule
  // list was present the model dropped the field entirely, and reordering or
  // rewording did not fix it. That made EVERY multi-database selection return
  // nothing, which is indistinguishable from the model choosing badly.
  test('the database argument is a closed enum of the connected names', async () => {
    const src = await Bun.file(new URL('./tool-selector.ts', import.meta.url)).text()
    // The enum is built from the loaded rows, not hardcoded.
    expect(src).toContain('databaseNames')
    expect(src).toMatch(/enum:\s*databaseNames/)
    // And it is REQUIRED, so the call cannot omit it when a choice exists, while
    // a single-database install can: the guard is `length <= 1`.
    expect(src).toMatch(/databaseNames\.length <= 1/)
    expect(src).toMatch(/required:\s*\['question',\s*'database'\]/)
  })

  test('the database list is NOT truncated with a take limit', async () => {
    const src = await Bun.file(new URL('./tool-selector.ts', import.meta.url)).text()
    // INCIDENT: `take: 20` against 23 connected databases silently hid three of
    // them, so a question about shipments could not name the database holding
    // them (MEASURED: SYNTH-Recruitment, SYNTH-Vendors, SYNTH-Logistics Euro).
    // A database the model cannot see is one it can never choose.
    const query = src.slice(src.indexOf('needsDatabaseListing'), src.indexOf('databaseBlock'))
    // The per-database TABLE list may still be trimmed (that only shortens the
    // prompt); what must not appear is a limit on the DATABASE query itself.
    const topLevelTake = query.match(/\n\s*take:\s*\d+/g) ?? []
    expect(topLevelTake).toHaveLength(0)
  })
})

describe('tool-selector — the routing prompt stays minimal', () => {
  // INCIDENT (MEASURED, N=40 per arm, 95% CI ±15pp, same question, tools and
  // database list held constant so the RULES were the only variable):
  //   full rule list (7 rules)                    63%
  //   minus "choose by what the question NEEDS"  100%
  //   minus the "MULTI_STEP" rule                100%
  //   minimal (2 rules)                          100%
  // Two rules each cost ~37pp. The "choose by what the question NEEDS" example
  // ("sales last month is a DATABASE question even though month sounds like a
  // date") teaches deliberation about surface words, and the model turned that
  // into "which database do you mean?" instead of calling the tool. This test
  // keeps the rule list short: a well-meant new rule can halve tool use.
  test('the rule list stays small', async () => {
    const src = await Bun.file(new URL('./tool-selector.ts', import.meta.url)).text()
    const body = src.slice(src.indexOf('const system = ['), src.indexOf('].filter(Boolean)'))
    const rules = body.match(/^\s+'-\s/gm) ?? []
    expect(rules.length, `found ${rules.length} rules: ${body}`).toBeLessThanOrEqual(3)
  })

  test('the rules never invite a clarifying question', async () => {
    const src = await Bun.file(new URL('./tool-selector.ts', import.meta.url)).text()
    const body = src.slice(src.indexOf('const system = ['), src.indexOf('].filter(Boolean)'))
    // A "reply with text instead" enumeration reads as a licence to ask. The
    // surviving text-only rule must be narrow and the no-confirmation rule must
    // be present, or tool use collapses.
    // Compare on COLLAPSED text: the prompt is one string literal per line, so a
    // pattern spanning a line break tests how the source is wrapped, not what the
    // model reads. That mistake is what failed here first.
    // Strip source punctuation too: the literal per line ends with `',` so a plain
    // whitespace collapse leaves `do NOT reply in , text`. What matters is the
    // WORDS the model reads, so reduce to lowercase words only.
    const words = body.toLowerCase().replace(/[^a-z\s]+/g, ' ').replace(/\s+/g, ' ')
    expect(words).toContain('do not reply in text to ask which database is meant')
    expect(words).not.toContain('reply in text only for these cases')
  })
})

describe('tool-selector — an empty reply is not a decision', () => {
  // MEASURED: with a model that cannot do function calling on this endpoint
  // (`ag/gemini-3.8-flash-low` returned EMPTY for a one-tool prompt while plain
  // chat answered "OK"), the selector used to report `no tool needed` and route to
  // CHAT. A question about sales was then answered from general knowledge, and the
  // audit reason claimed the model had decided against using data. An empty reply
  // must instead return null so the caller can fall back.
  test('the empty-reply branch returns null rather than a CHAT decision', async () => {
    const src = await Bun.file(new URL('./tool-selector.ts', import.meta.url)).text()
    const i = src.indexOf("if (rawText.trim() === '')")
    expect(i, 'the empty-reply guard must exist').toBeGreaterThan(-1)
    // ...and it must RETURN NULL, not a decision object.
    expect(src.slice(i, i + 80)).toMatch(/return null/)
  })

  test('a substantive text answer still routes to CHAT, not null', async () => {
    const src = await Bun.file(new URL('./tool-selector.ts', import.meta.url)).text()
    // The contrast that makes the guard meaningful: real text must still be a
    // legitimate "no tool" outcome, or greetings would fall through to the
    // heuristic fallback on every turn.
    expect(src).toMatch(/const contextual = looksContextual/)
    expect(src).toMatch(/model answered in text \(no tool needed\)/)
  })
})
