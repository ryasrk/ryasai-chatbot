import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DOCUMENTS_SOURCE_ID } from './chat-sources'

/**
 * The document-corpus pin, end to end.
 *
 * MEASURED HISTORY this pins, because both halves of it were wrong at different times:
 *   1. The picker offered only databases, so a knowledge officer could not pin the retriever to documents — the one
 *      control that makes retrieval deterministic, missing for the questions where a semantic miss cannot be
 *      recovered by rewording.
 *   2. A "Documents" option was then WRITTEN AND WITHDRAWN, with the note that it "needs support this path does not
 *      have". That note was WRONG: the router has accepted `documentIds` on both transports all along. Withdrawing
 *      was still right, because shipping the control without the plumbing would have changed nothing while telling
 *      the user it had.
 *
 * So these assertions check the PLUMBING, which is the part that was missing twice — not the presence of an option
 * in a dropdown.
 */
const read = (rel: string) => readFileSync(join(import.meta.dir, rel), 'utf8')

describe('document pin — the sentinel is mapped, never sent as an integration id', () => {
  test('the sentinel has one definition', () => {
    expect(DOCUMENTS_SOURCE_ID).toBe('__documents__')
    // A second literal would let the picker and the sender disagree about which value means "documents".
    const view = read('../components/views/chat-view.tsx')
    const send = read('../components/views/chat/use-chat-send.ts')
    for (const src of [view, send]) {
      const literals = src.match(/__documents__/g) ?? []
      // Allowed: the import and the send decision, never a bare literal.
      expect(literals.length).toBeLessThanOrEqual(1)
    }
  })

  test('the sender maps the sentinel to `pinToDocuments`, NOT to `integrationId`', () => {
    const send = read('../components/views/chat/use-chat-send.ts')
    /*
     * This is the assertion that matters. `/send` validates `integrationId` against `Integration` and returns 400
     * when nothing matches, so sending the sentinel there would make every document-pinned turn FAIL rather than
     * fall back — worse than the gap it fills.
     */
    expect(send).toMatch(/sourceId === DOCUMENTS_SOURCE_ID\s*\n?\s*\?\s*\{ pinToDocuments: true \}/)
    // The old unconditional form must be gone: it would send the sentinel as an integration id.
    expect(send).not.toMatch(/\.\.\.\(sourceId \? \{ integrationId: sourceId \} : \{\}\)/)
  })

  test('the route skips the integration lookup when the pin is present', () => {
    const route = read('../app/api/chat/sessions/[id]/send/route.ts')
    // Without the guard the lookup runs, finds nothing, and 400s — the document pin would be unusable.
    expect(route).toMatch(/if \(!pinToDocuments && typeof body\.integrationId/)
    // And the signal must reach the router, or the pin changes nothing.
    expect(route).toMatch(/pinToDocuments,/)
  })

  test('the router states the pin in its prompt with a STABLE label', () => {
    // The routing context moved to tool-router-routing.ts when the router was split; the pin lives there now.
    const router = read('./tool-router-routing.ts')
    expect(router).toMatch(/pinnedSourceName: args\.pinToDocuments/)
    // A label carrying the live document count would change the prompt whenever a document was added, so the same
    // question would produce different prompts on different days.
    expect(router).toMatch(/const DOCUMENTS_PIN_LABEL = 'the document corpus/)
    expect(router).not.toMatch(/DOCUMENTS_PIN_LABEL = `.*\$\{/)
  })

  test('the picker offers the corpus only when documents EXIST', () => {
    const view = read('../components/views/chat-view.tsx')
    // An install with no documents must not gain an option that can only fail.
    expect(view).toMatch(/if \(docCount > 0\) sources\.push/)
  })
})
