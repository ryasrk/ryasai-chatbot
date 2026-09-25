import { describe, expect, test } from 'bun:test'
import { hasRoutingMemory, memoryForRouting } from './memory-routing'

/**
 * The sample below is a REAL recall result, captured from this deployment against the
 * cognee v1.6.0 sidecar. It is the reason this module exists: 2019 characters of this
 * shape were injected into the ROUTING prompt on every chat turn.
 *
 * Keeping the verbatim capture (rather than a tidy synthetic string) is deliberate — the
 * noise is the specification, and a cleaned-up fixture would let the filter regress on the
 * exact text it has to handle.
 */
const REAL_RECALL = `This chunk is about:
- Roles: User, Assistant
- Systems: Mock LLM, CHAT tool
- Topics: Greeting, Identity question, Chat session

Facts:
- A user opened a chat session with the Indonesian greeting and question "Halo, siapa kamu?".
- The assistant, a mock LLM, replied "Jawaban uji dari mock LLM.".
- A CHAT tool call completed with success status and a latency of 3 ms.
- The session was identified as cmufrvxfp0036h8ha601qtv6l with timestamp 1790268912657.`

describe('memoryForRouting — drops bookkeeping, keeps knowledge', () => {
  test('the real captured recall loses its ids, timestamps, latencies and tool narration', () => {
    const out = memoryForRouting(REAL_RECALL)

    // The domain-ish content survives: what was asked, and that it was a greeting.
    expect(out).toContain('Halo, siapa kamu?')
    // `Topics:` survives on purpose — for real data this is where "distribution hub,
    // warehouse codes" lives. Only the chat-turn envelope is removed, not every keyed line.
    expect(out).toContain('Greeting, Identity question, Chat session')

    // The bookkeeping is gone. Each of these was present verbatim in the capture.
    expect(out).not.toContain('cmufrvxfp0036h8ha601qtv6l')
    expect(out).not.toContain('1790268912657')
    expect(out).not.toContain('latency of 3 ms')
    expect(out).not.toContain('CHAT tool call completed')
    expect(out).not.toContain('session was identified')
    expect(out).not.toContain('timestamp')
  })

  test('the output is much smaller than the input — that is most of the point', () => {
    const out = memoryForRouting(REAL_RECALL)
    // Measured: the capture is 2019 chars in production; the filter must not be a no-op.
    expect(out.length).toBeLessThan(REAL_RECALL.length / 2)
  })

  test('a uuid is dropped too, not just the cuid shape', () => {
    const out = memoryForRouting('Facts:\n- The run 3ced0143-eb04-578a-8670-4ede1114da7d finished.')
    expect(out).not.toContain('3ced0143')
  })

  test('domain values that merely LOOK like metadata are KEPT', () => {
    // The deliberate narrowness. cognee reuses the same keys for knowledge and for
    // bookkeeping (`- Systems: HUB-99` is a domain fact, `- Systems: Mock LLM, CHAT tool`
    // is noise), so filtering by KEY would have thrown away the knowledge to remove the
    // noise. Only unambiguous bookkeeping shapes are matched.
    const out = memoryForRouting(
      'Facts:\n- The primary distribution hub code is HUB-99.\n- Laravel is the backend framework.',
    )
    expect(out).toContain('HUB-99')
    expect(out).toContain('Laravel')
  })

  test('the KEYED shape splits the same way: value decides, not key', () => {
    // The exact pair from captured recall, same key, opposite verdicts. This is the case a
    // key-based filter got wrong (it removed both), so it is pinned separately from the
    // prose version above.
    const out = memoryForRouting(
      ['This chunk is about:', '- Systems: Mock LLM, CHAT tool', '- Systems: HUB-99'].join('\n'),
    )
    expect(out).toContain('HUB-99')
    expect(out).not.toContain('Mock LLM')
  })

  test('a chat-turn envelope key is dropped, but its NON-envelope value is not', () => {
    // `Roles` is always `User, Assistant` for a remembered chat turn, so the envelope is
    // dropped — but the guard is on the value, so a role list that IS knowledge survives.
    expect(memoryForRouting('Facts:\n- Roles: User, Assistant')).toBe('')
    expect(memoryForRouting('Facts:\n- Roles: apoteker, kasir')).toContain('apoteker')
  })

  test('bare headings are dropped, but a heading WITH content is kept', () => {
    expect(memoryForRouting('This chunk is about:\nThis chunk is about')).toBe('')
    expect(memoryForRouting('This chunk is about: distribution hubs')).toContain('distribution hubs')
  })

  test('empty, null and undefined all return empty rather than throwing', () => {
    expect(memoryForRouting('')).toBe('')
    expect(memoryForRouting(null)).toBe('')
    expect(memoryForRouting(undefined)).toBe('')
    // A blob of nothing but bookkeeping must also collapse to empty — the caller uses
    // that to avoid emitting an empty "Context from memory:" heading.
    expect(memoryForRouting('Facts:\n- timestamp 123\n- session id abc')).toBe('')
  })

  test('the result is bounded, so memory can never crowd out the tool list', () => {
    const huge = Array.from({ length: 200 }, (_, i) => `- The warehouse hub code for site ${i} is HUB-${i}.`).join('\n')
    const out = memoryForRouting(huge)
    expect(out.length).toBeLessThanOrEqual(600)
    // ...and it is a PREFIX, not a truncation mid-sentence of the last line.
    for (const line of out.split('\n')) {
      expect(huge).toContain(line)
      expect(line.endsWith('.')).toBe(true)
    }
  })

  test('maxChars is honoured when raised', () => {
    // The input has to be longer than the raised ceiling or the assertion is vacuous:
    // the first version used a 619-char input and asserted > 600, which cannot hold once
    // the `- ` markers are stripped, and it failed for that arithmetic reason rather than
    // a filtering one.
    const text = Array.from({ length: 120 }, (_, i) => `- Site ${i} uses hub code HUB-${i}.`).join('\n')
    expect(text.length).toBeGreaterThan(1200)
    expect(memoryForRouting(text, { maxChars: 1200 }).length).toBeGreaterThan(600)
    expect(memoryForRouting(text, { maxChars: 1200 }).length).toBeLessThanOrEqual(1200)
  })

  test('a single over-long line is dropped rather than cut in half', () => {
    // Half a sentence is a worse routing hint than a shorter honest one, so an oversized
    // line is skipped entirely.
    const long = `- ${'x'.repeat(700)}`
    expect(memoryForRouting(`${long}\n- HUB-99 is the hub code.`)).toBe('HUB-99 is the hub code.')
  })

  test('whitespace is normalised and list markers stripped', () => {
    const out = memoryForRouting('Facts:\n-   HUB-99   is   the   primary   hub code.')
    expect(out).toBe('HUB-99 is the primary hub code.')
  })
})

describe('hasRoutingMemory', () => {
  test('false when the filter would produce nothing, true otherwise', () => {
    expect(hasRoutingMemory('Facts:\n- timestamp 1790268912657')).toBe(false)
    expect(hasRoutingMemory(REAL_RECALL)).toBe(true)
    expect(hasRoutingMemory(undefined)).toBe(false)
  })
})
