/**
 * Reduce a recalled memory blob to something usable as a ROUTING signal.
 *
 * WHY THIS EXISTS. `recallContext()` returns whatever cognee extracted from past chat
 * turns, and that is mostly instrument metadata. Captured verbatim from this deployment
 * (a real recall, 2019 characters injected into the routing prompt every turn):
 *
 *     This chunk is about:
 *     - Roles: User, Assistant
 *     - Systems: Mock LLM, CHAT tool
 *     - Topics: Greeting, Identity question, Chat session
 *
 *     Facts:
 *     - A user opened a chat session with the Indonesian greeting and question "Halo, siapa kamu?".
 *     - The assistant, a mock LLM, replied "Jawaban uji dari mock LLM.".
 *     - A CHAT tool call completed with success status and a latency of 3 ms.
 *     - The session was identified as cmufrvxfp0036h8ha601qtv6l with timestamp 1790268912657.
 *
 * Session ids, timestamps, latencies and tool bookkeeping are not routing signal, and they
 * are not free: this text is rendered in the routing prompt directly beneath the rule
 * "Reply in text only when the question needs no data at all: … a message that refers to
 * earlier turns". A two-kilobyte block that looks like remembered conversation, sitting
 * under that instruction, is an invitation to answer from memory instead of calling a tool.
 *
 * WHAT THIS DOES NOT DO. It does not summarise, and it does not judge relevance — both
 * would need an LLM call on the routing path, which is the latency this layer exists to
 * avoid. It removes bookkeeping and bounds the size. Anything cleverer has to be measured.
 *
 * SCOPE. Applied ONLY where memory is used to CHOOSE a tool (tool-selector, routeQuery).
 * The answer prompts keep the full text: there, a session id and a timestamp are harmless,
 * and dropping detail could cost the answer.
 */

/**
 * Lines that are operational bookkeeping rather than remembered knowledge.
 *
 * Deliberately narrow. A broader rule was tried first and rejected: cognee's extractor
 * reuses the same key for knowledge and for metadata, so `- Systems: HUB-99` is a domain
 * fact while `- Systems: Mock LLM, CHAT tool` is noise. Filtering by KEY would have thrown
 * away the knowledge to remove the noise, so the rules below target only shapes that are
 * unambiguously bookkeeping — ids, timestamps, durations, and tool-lifecycle narration.
 */
const BOOKKEEPING: RegExp[] = [
  // Run ids (cuid/uuid) are never part of a routing question.
  /\bcm[a-z0-9]{20,}\b/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\bsession (?:was )?identified\b/i,
  /\bsession[ _]?id\b/i,
  /\btimestamp\b/i,
  /\blatency of \d+/i,
  /\btook \d+\s*ms\b/i,
  /\btool call (?:completed|finished|succeeded|failed)\b/i,
  /\bwith (?:success|error|failure) status\b/i,
  /\bstatus:\s*(?:success|error|failed)\b/i,
  // This deployment's OWN tooling, seen in captured recall. A routing question is never
  // about which tool answered a previous turn, and leaving these in teaches the router
  // that the memory is about tool usage.
  /\b(?:CHAT|SQL|RAG|REST|MCP) tool\b/i,
  /\bMock LLM\b/i,
]

/**
 * Keyed lines whose VALUE is entirely the chat-turn envelope.
 *
 * Filtered by value, never by key alone, and the distinction is not academic: the same
 * keys carry domain knowledge. Captured from real recall, both of these appear:
 *
 *     - Systems: Mock LLM, CHAT tool      <- envelope, noise
 *     - Systems: HUB-99                    <- domain fact, must survive
 *
 * `Roles` is the one key that is always envelope in this system (cognee emits it as
 * `User, Assistant` for every remembered chat turn), but even there the VALUE is checked,
 * so a hypothetical `Roles: admin, viewer` would still reach the router.
 */
const ENVELOPE_VALUES: Array<{ key: RegExp; value: RegExp }> = [
  { key: /^(?:Roles)$/i, value: /^(?:user|assistant|system|tool)(?:\s*,\s*(?:user|assistant|system|tool))*$/i },
  { key: /^(?:Events)$/i, value: /^(?:chat[_ ]?turn|message|request)(?:\s*,\s*[\w ]+)*$/i },
]

/** Headings that carry no content of their own once the lines under them are read. */
const BARE_HEADINGS = /^(this chunk is about|facts?|summary|details?)\s*:?\s*$/i

/** Is this keyed line envelope-only, judged by its VALUE? See ENVELOPE_VALUES. */
function isEnvelopeLine(line: string): boolean {
  const m = /^[-*]?\s*([A-Za-z_ ]+?)\s*:\s*(.+)$/.exec(line)
  if (!m) return false
  const key = m[1].trim()
  const value = m[2].trim()
  return ENVELOPE_VALUES.some((r) => r.key.test(key) && r.value.test(value))
}

export interface MemoryForRoutingOptions {
  /** Hard ceiling on the returned text. */
  maxChars?: number
}

/**
 * Return the routing-usable part of `memory`, or '' when there is nothing usable.
 *
 * Bounded by construction: the result never exceeds `maxChars`, so a memory blob can never
 * crowd out the tool list however large the store grows.
 */
export function memoryForRouting(
  memory: string | undefined | null,
  options: MemoryForRoutingOptions = {},
): string {
  const maxChars = options.maxChars ?? 600
  if (!memory) return ''

  const kept: string[] = []
  let used = 0

  for (const rawLine of memory.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (BARE_HEADINGS.test(line)) continue
    if (BOOKKEEPING.some((re) => re.test(line))) continue
    if (isEnvelopeLine(line)) continue

    // Strip the list marker so the result reads as prose, and normalise internal runs of
    // whitespace — cognee's extractor emits double spaces between sentences.
    const text = line.replace(/^[-*]\s+/, '').replace(/\s{2,}/g, ' ').trim()
    if (!text) continue
    if (text.length < 3) continue

    // A line longer than the whole budget is SKIPPED, not truncated and not treated as
    // "the budget is spent": half a sentence is a worse routing hint than a shorter honest
    // one, but it must not cost the lines after it. Measured defect: the first version
    // `break`-ed here, so one 700-char line returned '' and discarded a later
    // `HUB-99 is the hub code.` line that would have fit.
    if (text.length > maxChars) continue
    if (used + text.length > maxChars) break
    kept.push(text)
    used += text.length + 1
  }

  return kept.join('\n')
}

/**
 * Render the recalled memory for a ROUTING prompt, framed as background rather than answer.
 *
 * WHY THE FRAMING AND NOT JUST THE FILTER. Filtering the text was tried first and did not
 * change routing at all (measured; see docs/cognee-http-migration.md). What the numbers
 * showed instead was a mechanism: with memory present the selector increasingly chose to
 * ANSWER (`CHAT`) instead of fetching — 10 of 14 on a question whose answer was in a
 * document. That is the predictable result of dropping a block of remembered conversation
 * into a prompt whose rules are about whether to answer or to call a tool: nothing in the
 * block says it is a record of PAST turns rather than material for THIS one, and its own
 * text ("The assistant replied …") reads like an answer already given.
 *
 * So the block now states what it is, what it is not, and what it must not be used for. The
 * wording is deliberately blunt and short: this is a routing decision made at temperature 0
 * and there is one question to answer, so the framing is a constraint, not a discussion.
 */
export function routingMemoryBlock(memory: string | undefined | null): string {
  const body = memoryForRouting(memory)
  if (!body) return ''
  return [
    'Background from earlier conversations (NOT an answer to the current question, and',
    'NOT a reason to skip a tool):',
    body,
    'Use this only to understand what the user is referring to. If answering the current',
    'question requires data — a document, a database, an API — call that tool even when the',
    'background above looks like it already contains an answer.',
  ].join('\n')
}

