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
