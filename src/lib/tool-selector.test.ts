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

describe('tool-selector — no promise of a switch that does nothing', () => {
  test('TOOL_SELECTION is not documented as a working option, because nothing reads it', async () => {
    // The header once promised `TOOL_SELECTION=heuristic`. Setting it changed nothing, so an operator who set it
    // believed they had opted out of per-turn routing cost and had not. A flag is only real if some code reads it.
    const src = await Bun.file(new URL('./tool-selector.ts', import.meta.url)).text()
    const readers = (await Array.fromAsync(new Bun.Glob('src/**/*.ts').scan({ cwd: process.cwd() })))
      .filter((f) => !f.endsWith('.test.ts'))
    let reads = 0
    for (const f of readers) {
      const text = await Bun.file(f).text()
      if (/process\.env\.TOOL_SELECTION/.test(text)) reads += 1
    }
    const promisesIt = /`TOOL_SELECTION=heuristic`\s+keeps/.test(src)
    // Either the flag is honoured by code, or the comment must not promise it.
    expect(reads > 0 || !promisesIt).toBe(true)
  })

  test('the levers the header now names really are read by code', async () => {
    // Speculative routing lives in tool-router-routing.ts since the router was split.
    const router = await Bun.file(new URL('./tool-router-routing.ts', import.meta.url)).text()
    const simple = await Bun.file(new URL('./simple-pipeline.ts', import.meta.url)).text()
    expect(/process\.env\.SPECULATIVE_ROUTING/.test(router)).toBe(true)
    expect(/process\.env\.SIMPLE_PIPELINE/.test(simple)).toBe(true)
  })
})

describe('tool-selector — every tool call is resolved, not just the first', () => {
  /*
   * MEASURED DEFECT: the selector read `result[0]` and threw the rest away. On the compound question "berapa hari cuti
   * tahunan karyawan tetap dan berapa gaji pokok direktur utama?" the model emitted `search_knowledge_base` AND
   * `query_database` on 5 of 16 tries — and only the first was ever acted on, so one half of the question was dropped
   * with nothing reporting it.
   *
   * The existing multi-tool signal could not catch that case: `needsMultipleTools` is parsed from the model's TEXT,
   * and a reply carrying tool calls has NO text (`rawText` is '' whenever the result is an array) — MEASURED over 40
   * selections it never once fired. This file holds the parsing to the calls themselves.
   */
  const src = () => Bun.file(new URL('./tool-selector.ts', import.meta.url)).text()

  test('the extra calls are parsed, mapped through the same table, and returned', async () => {
    const body = await src()
    expect(body).toMatch(/for \(const other of result\.slice\(1\)\)/)
    expect(body).toMatch(/byFunctionName\.get\(other\.name\) \?\? functionNameToToolId\(other\.name\)/)
    expect(body).toMatch(/extraTools\.push\(\{ toolId: otherId, args: otherArgs \}\)/)
  })

  test('an unknown or repeated call is DROPPED rather than carried', async () => {
    const body = await src()
    // An unknown name must not become a tool id, and an identical call would run the same source twice. A repeat is
    // the same tool with the SAME arguments: the same tool with different arguments is another part of the question.
    expect(body).toMatch(/if \(!otherId \|\| seenCalls\.has\(callKey\(otherId, other\.arguments\)\)\) continue/)
  })

  test('the prompt no longer limits the model to one tool', async () => {
    const body = await src()
    expect(body).not.toMatch(/the single best tool for the user question, then call it\.'/)
    expect(body).toMatch(/call one tool per part in the same reply/)
  })

  test('a malformed argument blob still counts as a REQUEST for that source', async () => {
    const body = await src()
    // The tool id is what the caller routes on; the branch falls back to the user's question when its argument is
    // missing. Dropping the call over a JSON detail would lose half of a compound question.
    const i = body.indexOf('for (const other of result.slice(1))')
    const block = body.slice(i, i + 900)
    expect(block).toMatch(/catch \{/)
    expect(block).not.toMatch(/catch \{\s*continue/)
  })

  test('the multi-tool plan is only entered when the caller allowed multi-step', async () => {
    // The planner costs an extra LLM call on a BYOK key, so a caller that opted out must not be charged for it.
    const router = await Bun.file(new URL('./tool-router.ts', import.meta.url)).text()
    expect(router).toMatch(/if \(extraToolIds\.length > 0 && args\.allowMultiStepDag\)/)
  })

  test('a planner that declines leaves the first source answering', async () => {
    const router = await Bun.file(new URL('./tool-router.ts', import.meta.url)).text()
    // `if (dag)` — not an unconditional return. A null plan must not turn a routable question into no answer.
    expect(router).toMatch(/if \(dag\) \{/)
  })
})

describe('tool descriptions state the ROLE, not only the topics', () => {
  /*
   * MEASURED PROBLEM. On a deployment where a database and a document set cover the SAME subject (an HR database
   * beside HR policy documents), the SQL tool's description listed topics only ("sales, orders, customers, inventory,
   * invoices"), so a question about a leave ENTITLEMENT looked like a query against the leave TABLE. NEGATIVE-CONTROL,
   * N=20 per arm on the same four questions: reverting these descriptions to the topic-only wording dropped the
   * document-correct answers from 20/20 to 13/20 (65%), with six going to the database. With the role stated: 80/80.
   *
   * The distinction has to live in the TOOL DESCRIPTION rather than as another system-prompt rule: MEASURED at N=40,
   * the existing rule list already costs accuracy (~37pp per added rule), which is why it is kept short.
   */
  const src = () => Bun.file(new URL('./unified-tools.ts', import.meta.url)).text()

  test("the database tool says it answers what the records SAY, and refuses the rules", async () => {
    const body = await src()
    expect(body).toContain('what the data ')
    expect(body).toContain('Do NOT use it for what a policy, SOP or rule DEFINES')
  })

  test('the document tool says it answers what the RULES DEFINE', async () => {
    const body = await src()
    expect(body).toContain('what the RULES DEFINE')
    // The disqualifier is the load-bearing half: without it the model still reaches for the table that shares the
    // topic, which is exactly what the negative control measured.
    expect(body).toContain('even when a database table of the same')
  })

  test('the topics are still listed, so ordinary database questions keep routing correctly', async () => {
    const body = await src()
    // The control arm of the measurement: 100% of genuine database questions still went to the database with the new
    // wording, and 40/40 at N=40. Removing the topic list to make room for the role text would break that.
    expect(body).toContain('sales, orders, customers, inventory, invoices, employees, financial figures')
  })
})
