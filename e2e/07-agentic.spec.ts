import { test, expect } from '@playwright/test'

/**
 * Agentic (ReAct) surface — permanent CI coverage.
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS. Every unit test of the orchestrator mocks the LLM, so
 * none of them can show that the real transport, the real SSE route, and a real
 * tool round-trip actually cooperate. That blind spot shipped a defect in
 * 2026-09: the outgoing assistant `tool_calls` lacked the OpenAI wire shape
 * (`type: "function"` + nested `function`), so round 1 (request a tool) worked
 * and round 2 (observation -> answer) threw on every turn. Nothing in CI noticed.
 *
 * WHAT IT PINS:
 *   1. The SSE endpoint answers 200 / text/event-stream with well-formed,
 *      blank-line-terminated frames and no illegal event names.
 *   2. A tool-calling turn completes: tool_start -> tool_end -> answer -> done.
 *      This is the exact shape that regressed.
 *   3. The outgoing tool_call serializes with `type: "function"`, enforced by
 *      the mock LLM itself (it 400s on a malformed tool_call), so a future
 *      regression fails here loudly instead of silently truncating turns.
 *
 * Runs against the mock LLM on :4545 — no external provider, deterministic.
 */

const MOCK_LLM = 'http://127.0.0.1:4545'
const LEGAL_EVENTS = [
  'thinking',
  'plan',
  'tool_start',
  'tool_end',
  'token',
  'answer',
  'done',
  'confirmation_required',
  'error',
]

async function configureMock(body: Record<string, unknown>) {
  const res = await fetch(`${MOCK_LLM}/__mock/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.ok, 'mock LLM control endpoint must accept the config').toBe(true)
}

async function mockState(): Promise<{ shapeViolations: number; toolCall: string | null }> {
  const res = await fetch(`${MOCK_LLM}/__mock/state`)
  return (await res.json()) as { shapeViolations: number; toolCall: string | null }
}

/**
 * Reach the dashboard, logging in only when the app actually asks.
 *
 * WHY THE CONDITIONAL: 01-setup-wizard.spec.ts leaves an authenticated session
 * cookie behind, so on a full-suite run the app may already be inside. Waiting
 * on `#email` unconditionally would then hang on a field that never appears.
 */
async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/')

  // The app either shows the sign-in form or (session still valid from the
  // setup-wizard spec) goes straight to the dashboard. Decide by waiting for
  // whichever appears, then act strictly sequentially — a raced fill can land
  // before the form is interactive and silently leave us on the login screen.
  const emailInput = page.locator('#email')
  const dashboard = page.getByRole('heading', { name: 'Dashboard' })

  await emailInput.or(dashboard).first().waitFor({ timeout: 25_000 })

  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill('admin@e2e.test')
    await page.locator('#password').fill('password123')
    await page.getByRole('button', { name: /Sign In/i }).click()
  }

  await expect(dashboard).toBeVisible({ timeout: 25_000 })
}

/** Parse the raw SSE text the way a browser would — nothing about the format is assumed. */
function parseFrames(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  const out: Array<{ event: string; data: Record<string, unknown> }> = []
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue
    const evLine = block.split('\n').find((l) => l.startsWith('event: '))
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
    if (!evLine || !dataLine) continue
    try {
      out.push({ event: evLine.slice(7), data: JSON.parse(dataLine.slice(6)) })
    } catch {
      /* a frame we cannot parse is itself a failure the caller can assert on */
    }
  }
  return out
}

test.describe('agentic ReAct surface', () => {
  test.afterEach(async () => {
    // Leave the mock in its default state so sibling specs see unchanged behaviour.
    await configureMock({ toolCall: null, verifyToolCallShape: false })
  })

  test('a conversational turn streams well-formed SSE frames and answers', async ({ page }) => {
    await configureMock({ toolCall: null, verifyToolCallShape: true })
    await signIn(page)

    // Intercept at the ROUTE, not via page.on('response'). A response listener
    // hands back an already-consumed stream, so `r.text()` yields '' and the
    // assertion silently sees zero frames (MEASURED). Routing lets us read the
    // body before the page consumes it.
    const streams: Array<{ status: number; ct: string; body: string }> = []
    await page.route('**/api/agent/dashboard', async (route) => {
      const res = await route.fetch()
      const ct = res.headers()['content-type'] ?? ''
      if (ct.includes('event-stream')) {
        const body = await res.text()
        streams.push({ status: res.status(), ct, body })
        await route.fulfill({ response: res, body })
        return
      }
      await route.fulfill({ response: res })
    })

    await page.getByRole('button', { name: /agentic/i }).first().click()
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 15_000 })
    await page.locator('textarea').first().fill('Reply briefly: what is 2 + 2?')
    // The composer's send control is the only button with aria-label="Send";
    // a generic `button:has(svg)` also matches nav/stop controls.
    await page.getByRole('button', { name: 'Send' }).click()

    await expect(page.getByText(/Jawaban uji dari mock LLM/i)).toBeVisible({ timeout: 30_000 })

    expect(streams, 'the UI must call the agent SSE endpoint').toHaveLength(1)
    const s = streams[0]
    expect(s.status).toBe(200)
    expect(s.ct).toContain('text/event-stream')

    // Frame format: every frame ends with a blank line, and every name is known.
    expect(s.body.endsWith('\n\n')).toBe(true)
    const frames = parseFrames(s.body)
    expect(frames.length).toBeGreaterThan(0)
    const names = frames.map((f) => f.event)
    for (const n of names) expect(LEGAL_EVENTS).toContain(n)

    // The mandatory shape of a completed turn.
    expect(names).toContain('thinking')
    expect(names).toContain('answer')
    expect(names).toContain('done')
  })

  test('a tool-calling turn completes end to end (the 2026-09 regression)', async ({ page }) => {
    // Make the mock answer the FIRST completion with a tool call to a REAL
    // registered tool, and the follow-up with final text. This is precisely the
    // two-round path that used to throw.
    await configureMock({ toolCall: 'web_search', verifyToolCallShape: true })
    await signIn(page)

    const streams: string[] = []
    await page.route('**/api/agent/dashboard', async (route) => {
      const res = await route.fetch()
      if ((res.headers()['content-type'] ?? '').includes('event-stream')) {
        const body = await res.text()
        streams.push(body)
        await route.fulfill({ response: res, body })
        return
      }
      await route.fulfill({ response: res })
    })

    await page.getByRole('button', { name: /agentic/i }).first().click()
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 15_000 })
    await page.locator('textarea').first().fill('Search the web for something and then answer.')
    // The composer's send control is the only button with aria-label="Send";
    // a generic `button:has(svg)` also matches nav/stop controls.
    await page.getByRole('button', { name: 'Send' }).click()

    // Round 2 produced text; the turn must NOT die on a parse error.
    await expect(page.getByText(/MOCK_ANSWER_AFTER_TOOL/i)).toBeVisible({ timeout: 40_000 })

    // The tool the model asked for must be visible in the transcript.
    const body = await page.locator('body').innerText()
    expect(body).toMatch(/web_search/i)

    expect(streams, 'the turn must produce an SSE stream').toHaveLength(1)
    const framesSeen = parseFrames(streams[0])
    const names = framesSeen.map((f) => f.event)
    expect(names, `frames seen: ${names.join(',')}`).toContain('tool_start')
    expect(names).toContain('tool_end')
    expect(names.indexOf('tool_start')).toBeLessThan(names.indexOf('tool_end'))
    expect(names).toContain('done')
    // No error frame: the multi-round transport survived.
    expect(names).not.toContain('error')

    const start = framesSeen.find((f) => f.event === 'tool_start')!
    expect(String(start.data.tool)).toContain('web_search')

    // The wire-shape guard in the mock LLM saw NOTHING malformed.
    const st = await mockState()
    expect(st.shapeViolations, 'no malformed tool_call on the wire').toBe(0)
  })
})
