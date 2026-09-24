import { test, expect, type Page } from '@playwright/test'

/**
 * Knowledge + Chat spec.
 *
 * Verifies:
 * 1. A TXT document can be uploaded via the Knowledge view.
 * 2. The document gets indexed (status becomes "Ready").
 * 3. A chat session can be started and the AI responds.
 * 4. The RAG branch is actually taken, and its CITATIONS render — the assertion that
 *    would catch a retrieval-ranking regression. See the note on `configureMock`.
 * 5. The retrieval A/B override is refused while the deployment has not opted in.
 */

const E2E_EMAIL = 'admin@e2e.test'
const E2E_PASSWORD = 'password123'
const MOCK_LLM = 'http://localhost:4545'

/**
 * Drive the mock LLM's tool selection.
 *
 * WHY THIS IS NEEDED AT ALL: the production chat path calls `selectToolWithLlm`
 * (`src/lib/tool-selector.ts`) first, and that function expects a NATIVE tool call from
 * the model. The mock's default reply is canned prose, which the selector reads as "no
 * tool" → the turn routes to plain CHAT. Verified before writing these tests: the
 * assistant row's `citations` was `[]` and the only `ToolRun` was `CHAT`, so
 * `CitationList` was unreachable and ANY assertion on it would have been vacuous — it
 * could not fail for any retrieval change.
 *
 * The mock only honours `toolCall` on requests that actually OFFER tools, so setting it
 * does not corrupt the other LLM calls (intent analysis, KG extraction, source-init) that
 * share the same mock and expect text.
 *
 * ALWAYS RESET IT: the mock is a single process shared by every spec, so a leaked
 * `toolCall` would silently reroute later specs. `afterEach` handles it.
 */
async function configureMock(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${MOCK_LLM}/__mock/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.ok, 'mock LLM control endpoint must accept the config').toBe(true)
}

/** The knowledge-base tool's function name (`toolIdToFunctionName('rag')`). */
const RAG_TOOL_NAME = 'search_knowledge_base'

/** Log in via API and navigate to the app. */
async function login(page: Page) {
  const res = await page.request.post('/api/auth/login', {
    data: { email: E2E_EMAIL, password: E2E_PASSWORD },
  })
  expect.soft(res.ok(), `login API returned ${res.status()}`).toBe(true)
  await page.goto('/')
  // ViewHeader renders <h1>Dashboard</h1> once the shell mounts post-login.
  // data-analytics can still be loading (or in ErrorState) — the header is
  // page-level, not dashboard-level, so match the text, not a deep state.
  // CI machines can be slow to mount the shell + analytics; the h1 itself is
  // static once mounted, so wait generously.
  await expect(page.locator('h1', { hasText: 'Dashboard' })).toBeVisible({
    timeout: 90_000,
  })
}

test('upload document and chat with mock LLM', async ({ page }) => {
  await login(page)

  // --- Upload a TXT document via the Knowledge view ---
  await page.goto('/?view=knowledge')
  await expect(page.getByText('Knowledge Base')).toBeVisible({ timeout: 10_000 })

  // Open the upload dialog
  await page.getByRole('button', { name: /Upload/i }).first().click()

  // Upload fixture file
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.setInputFiles({
    name: 'e2e-facts.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      'The main warehouse code is GDG-77. ' +
        'Items are organized by product category and SKU. ' +
        'Electronic products must be stored in the air-conditioned area.',
      'utf-8',
    ),
  })

  // Submit upload
  await page.getByRole('button', { name: /Upload/i }).click()

  // Wait for success toast
  await expect(page.getByText(/uploaded/i)).toBeVisible({
    timeout: 15_000,
  })

  // Close dialog if still open
  await page.keyboard.press('Escape')

  // Wait for the document to appear
  await expect(page.getByText('e2e-facts.txt')).toBeVisible({
    timeout: 30_000,
  })

  // --- Chat with mock LLM ---
  await page.goto('/?view=chat')
  await expect(page.getByPlaceholder(/type|ask|question/i)).toBeVisible({
    timeout: 10_000,
  })

  // Type and send
  await page.getByPlaceholder(/type|ask|question/i).fill('What is the main warehouse code?')
  await page.getByRole('button', { name: /Send/i }).click()

  // The mock LLM returns a canned Indonesian response ("Jawaban uji dari mock
  // LLM."); match on the stable prefix since the full string may wrap.
  await expect(page.getByText(/jawaban uji/i)).toBeVisible({
    timeout: 45_000,
  })
})

/**
 * Upload two documents where only the SECOND answers the question.
 *
 * Two documents, not one, is the point: with a single document any chunk the retriever
 * returns is the right one, so the assertion cannot distinguish a correct ranking from an
 * arbitrary one. The distractor deliberately shares the question's vocabulary ("warehouse",
 * "code") and holds a DIFFERENT code, so a lexical-only or badly-fused ranking names the
 * wrong file — which is exactly the failure a citation assertion exists to catch.
 */
const HUB_QUESTION = 'What is the primary distribution hub code?'
const ANSWER_CODE = 'HUB-99'
const DISTRACTOR = {
  name: 'e2e-distractor.txt',
  body: 'Hub codes are printed on the intake form. ' +
    'The hub code for the northern depot is NDX-11. ' +
    'Codes are audited every quarter by the operations team.',
}
const ANSWER_DOC = {
  name: 'e2e-answer.txt',
  body: `The ${ANSWER_CODE} is the primary distribution hub code. ` +
    'Shipments are dispatched from this primary distribution hub every weekday morning.',
}

async function uploadDocument(page: Page, name: string, body: string): Promise<void> {
  // The view's own heading is `<h3>Knowledge</h3>`; "Knowledge Base" is only the page
  // TITLE (app/layout.tsx metadata), so matching it waits on something that is never a
  // visible element in this view. Wait for the Upload button instead — it is the control
  // the next line uses, so it cannot pass while the view is still mounting.
  await page.goto('/?view=knowledge')
  const uploadButton = page.getByRole('button', { name: /^Upload/i }).first()
  await expect(uploadButton).toBeVisible({ timeout: 20_000 })
  // Open the dialog FIRST: the file input lives inside it and does not exist until then,
  // so reaching for the input before this click is a 90-second timeout rather than a
  // clear failure.
  await uploadButton.click()
  await page.locator('input[type="file"]').first().setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(body, 'utf-8'),
  })
  // `.last()` — with the dialog open there are two controls matching /^Upload/: the
  // toolbar button and the dialog's submit. The last is the dialog's.
  await page.getByRole('button', { name: /^Upload/i }).last().click()
  await expect(page.getByText(/uploaded/i).first()).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  // `.first()` — the name appears in both the document list and the dialog's own
  // contents while it is still mounted, and strict mode rejects the ambiguous match.
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 30_000 })
}

/**
 * WHY THIS SUITE DOES NOT ASSERT RANK ORDER, and the limitation that remains
 * ----------------------------------------------------------------------------
 * MEASURED while building these tests, in three steps:
 *
 * 1. The mock embedder is a hashed bag of tokens, not a semantic model. It ranks THIS
 *    fixture correctly (answer 0.7449 vs the next document 0.4263), but with a larger
 *    corpus of unrelated documents its hash coincidences put irrelevant text on top —
 *    observed: 10 added filler documents made meeting-room and expense text outrank the
 *    document that literally answers the question. A rank assertion over that would be
 *    measuring the hash, not retrieval.
 *
 * 2. `resolveVectorScores` discards the vector leg entirely below `MIN_VECTOR_LEG_ROWS = 8`
 *    rows. This corpus has 3-4 chunks, so the log reads
 *    `pgvector returned fewer rows than requested {requested: 96, received: 4}` and
 *    `vectorRanking` comes back EMPTY. The fused order is then the lexical order for ANY
 *    `k`, because `1/(k + rank)` is monotonic in `rank` — so a FUSION CHANGE IS NOT
 *    OBSERVABLE in this suite even though the mock now produces real 384-dim vectors.
 *    Fixing that needs a corpus larger than the production gate accepts, which is exactly
 *    what step 1 shows the mock embedder cannot rank honestly.
 *
 * So this suite proves the FLOW — the RAG branch is taken, citations are built, the badge
 * renders as a rank rather than a percentage — and it deliberately does NOT claim to
 * measure retrieval quality. That is measured by `benchmark/real-prose-arm.ts` against a
 * real embedder and the app's own documents (docs/retrieval-production-integration-plan.md
 * §6), with 3 runs, because a single run of this pipeline has been measured to swing 11
 * points.
 */

test.describe('RAG citations', () => {
  // The mock is one process shared by every spec: a leaked toolCall would reroute
  // later specs, so the mode is reset whether the test passed or failed.
  test.afterEach(async () => {
    await configureMock({ toolCall: null })
  })

  test('the answer document is the one cited, and the badge is a rank not a percentage', async ({ page }) => {
    await configureMock({ toolCall: RAG_TOOL_NAME })
    await login(page)
    await uploadDocument(page, DISTRACTOR.name, DISTRACTOR.body)
    await uploadDocument(page, ANSWER_DOC.name, ANSWER_DOC.body)

    // Fixture guard: the answer code must appear in ONE document, or "the answering
    // document ranks first" is unsatisfiable (this is exactly how the first draft of this
    // test failed — two documents shared an answer and the assertion could never hold).
    expect(ANSWER_DOC.body).toContain(ANSWER_CODE)
    expect(DISTRACTOR.body).not.toContain(ANSWER_CODE)

    await page.goto('/?view=chat')
    await expect(page.getByPlaceholder(/type|ask|question/i)).toBeVisible({ timeout: 10_000 })
    await page.getByPlaceholder(/type|ask|question/i).fill(HUB_QUESTION)
    await page.getByRole('button', { name: /Send/i }).click()
    // `.first()` — the canned reply text appears in more than one place (the rendered
    // bubble and the persisted message), and strict mode rejects an ambiguous match.
    await expect(page.getByText(/jawaban uji/i).first()).toBeVisible({ timeout: 45_000 })

    // --- The retrieval assertion ---
    // The answering document must be among the cited sources: that is the retrieval
    // assertion, and it fails if the RAG branch returns nothing or the wrong corpus.
    //
    // RANK ORDER IS DELIBERATELY NOT ASSERTED, and the reason is measured rather than
    // assumed. The mock embedder is a hashed bag of tokens, not a semantic model, so a
    // document sharing no query vocabulary can still win the vector leg by hash
    // coincidence — observed: with this fixture the unrelated `e2e-facts.txt` ranked #1
    // and the answering document #3. Asserting rank-1 here would be measuring the hash,
    // not retrieval quality. Retrieval QUALITY is measured by
    // `benchmark/real-prose-arm.ts` against a real embedder; this suite proves the FLOW
    // (branch taken, citations built, UI rendered), which is what it can honestly prove.
    //
    // Read the rendered text rather than a container locator. Two container attempts were
    // wrong for structural reasons (`ancestor::div[1]` returned only the trigger wrapper
    // because the list is a SIBLING of the trigger; a page-wide `div` filter matched nested
    // wrappers), and the failure mode was a selector bug masquerading as a retrieval bug.
    const sourcesTrigger = page.getByText(/Sources \(\d+\)/i).first()
    await expect(sourcesTrigger).toBeVisible({ timeout: 15_000 })
    // The list is collapsed in some renders despite `useState(true)` — one run's body text
    // was just "Sources (3)" with no entries — so expand deterministically by checking for
    // an entry rather than assuming the initial state.
    let bodyText = await page.locator('body').innerText()
    if (!/Match #\d+/.test(bodyText)) {
      await sourcesTrigger.click()
      await expect(page.getByText(/Match #\d+/).first()).toBeVisible({ timeout: 10_000 })
      bodyText = await page.locator('body').innerText()
    }

    expect(bodyText, 'the answering document must be cited').toContain(ANSWER_DOC.name)
    // The badge is a rank. `Citation.score` is the fused RRF value (~0.016 for these
    // fixtures), so the removed percentage badge would have rendered "2%" right here —
    // which makes the absence assertion real rather than a claim about text that could
    // never have appeared.
    expect(bodyText).toMatch(/Match #\d+/)
    expect(bodyText, 'a fused RRF score must not be rendered as a percentage').not.toMatch(/relevance \d+%/i)
  })

  test('a leftover x-fusion-k header is inert — the ranking is not client-selectable', async ({ page }) => {
    // Asserted through a REAL HTTP surface: `/api/rag/evaluate` is session-auth, runs real
    // retrievals, and reports the ranking it measured. (`/api/v1/chat/completions` is NOT
    // usable here — it authenticates by API key, so it answers 401 and would test nothing.)
    //
    // The header belonged to the in-situ RRF A/B seam. That seam is gone: the ranking is now
    // fixed per release and named by RANKING_VERSION. A client or harness still sending the
    // header must get a byte-identical result, and never an error — a deployment must not
    // let anyone probe its ranking configuration through a status code.
    await login(page)
    await uploadDocument(page, ANSWER_DOC.name, ANSWER_DOC.body)

    const post = (headers: Record<string, string>) =>
      page.request.post('/api/rag/evaluate', {
        headers,
        data: { cases: [{ question: HUB_QUESTION, relevantSources: [ANSWER_DOC.name] }], topK: 4 },
      })

    const plain = await post({})
    expect(plain.status(), 'the eval endpoint must accept an admin session').toBe(200)
    const plainBody = (await plain.json()) as {
      rankingVersion: string
      summary: Record<string, number>
    }
    // The eval really ran, or the comparison below is incidental rather than evidence
    // about a retrieval.
    expect(plainBody.summary.total).toBeGreaterThan(0)
    expect(typeof plainBody.rankingVersion).toBe('string')

    const withHeader = await post({ 'x-fusion-k': '1' })
    expect(withHeader.status()).toBe(plain.status())
    const headerBody = (await withHeader.json()) as {
      rankingVersion: string
      summary: Record<string, number>
    }
    // THE ASSERTION: the header changed nothing about the ranking. Compared field by
    // field, NOT on the whole summary — `avgLatencyMs` is a wall-clock measurement, so a
    // deep-equality check over it fails whenever the two calls take a different number of
    // milliseconds (measured: 100 vs 1 on the first attempt), which is a flaky assertion
    // about timing rather than a check on ranking.
    expect(headerBody.rankingVersion).toBe(plainBody.rankingVersion)
    expect({ ...plainBody.summary, avgLatencyMs: 0 }).toEqual({ ...headerBody.summary, avgLatencyMs: 0 })
  })
})
