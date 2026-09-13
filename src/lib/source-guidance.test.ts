import { describe, expect, it } from 'bun:test'
import { buildSourceGuidance } from './source-guidance'

describe('buildSourceGuidance', () => {
  it('returns empty string when no prompts and no org prompt', () => {
    expect(buildSourceGuidance([])).toBe('')
    expect(buildSourceGuidance([], { orgPrompt: '' })).toBe('')
  })

  it('returns empty string when only empty-content prompts are provided', () => {
    // A doc whose contextPrompt is whitespace only is a no-op — the caller
    // must not see a header with no body.
    expect(
      buildSourceGuidance([{ name: 'doc.txt', content: '   ' }]),
    ).toBe('')
    expect(
      buildSourceGuidance([{ name: '', content: 'something' }]),
    ).toBe('')
  })

  it('emits org-only block when orgPrompt is non-empty', () => {
    const out = buildSourceGuidance([], { orgPrompt: 'Be concise.' })
    expect(out).toBe('[Source guidance]\nBe concise.')
  })

  it('emits one Document line per non-empty prompt', () => {
    const out = buildSourceGuidance([
      { name: 'policy.pdf', content: 'Treat as confidential.' },
      { name: 'sop.docx', content: 'Always cite the SOP number.' },
    ])
    expect(out).toBe(
      '[Source guidance]\n' +
        'Document "policy.pdf": Treat as confidential.\n' +
        'Document "sop.docx": Always cite the SOP number.',
    )
  })

  it('combines org prompt and doc prompts', () => {
    const out = buildSourceGuidance(
      [{ name: 'policy.pdf', content: 'Treat as confidential.' }],
      { orgPrompt: 'Be concise.' },
    )
    expect(out).toBe(
      '[Source guidance]\nBe concise.\nDocument "policy.pdf": Treat as confidential.',
    )
  })

  it('preserves caller-supplied (score) order', () => {
    const out = buildSourceGuidance([
      { name: 'high-score.txt', content: 'first' },
      { name: 'mid-score.txt', content: 'second' },
      { name: 'low-score.txt', content: 'third' },
    ])
    const lines = out.split('\n')
    expect(lines[1]).toContain('high-score.txt')
    expect(lines[2]).toContain('mid-score.txt')
    expect(lines[3]).toContain('low-score.txt')
  })

  it('truncates prompts that overflow the budget with …[truncated]', () => {
    const big = 'x'.repeat(3000)
    const out = buildSourceGuidance(
      [{ name: 'big.txt', content: big }],
      { budget: 500 },
    )
    expect(out).toContain('…[truncated]')
    expect(out.length).toBeLessThanOrEqual(500)
  })

  it('drops overflow prompts and adds an omitted-count note', () => {
    const out = buildSourceGuidance(
      [
        { name: 'a', content: 'aa' },
        { name: 'b', content: 'bb' },
        { name: 'c', content: 'cc' },
        { name: 'd', content: 'dd' },
        { name: 'e', content: 'ee' },
      ],
      { budget: 90 },
    )
    expect(out).toContain('source prompt')
    expect(out).toContain('omitted')
  })

  it('trims whitespace around content', () => {
    const out = buildSourceGuidance(
      [{ name: 'doc.txt', content: '  trimmed here  ' }],
      { orgPrompt: '  also trimmed  ' },
    )
    expect(out).toContain('Document "doc.txt": trimmed here')
    expect(out).toContain('also trimmed')
  })
})

// ===========================================================================
// The budget edges that were never exercised
// ===========================================================================

describe('buildSourceGuidance — budget edges', () => {
  it('TRUNCATES the ORG prompt when it does not fit but a suffix still does', () => {
    // Line 65-67. The org prompt applies to EVERY RAG answer, so it is kept (cut
    // down) rather than dropped as long as even the truncation suffix fits. This
    // branch is distinct from the doc-prompt truncation: a dropped org prompt would
    // strip organization-wide policy out of every answer silently.
    const org = 'x'.repeat(500)
    // Budget leaves room for the header plus a partial org line and the suffix.
    const out = buildSourceGuidance([], { orgPrompt: org, budget: 100 })
    expect(out).toContain('[Source guidance]')
    expect(out).toContain('…[truncated]')
    // Truncated DOWN, not emitted whole. The budget is spent EXACTLY (length 100,
    // not less) -- my first assertion said < 100 and failed; the code accounts for
    // the header, its newline and the suffix precisely, which is the better
    // behaviour. Asserted as an exact contract instead of a loose bound.
    expect(out.length).toBe(100)
    expect(out).not.toContain(org)
  })

  it('does NOT truncate the org prompt when the suffix itself does not fit', () => {
    // The `else if (remaining > TRUNC_SUFFIX.length)` guard. With almost no budget
    // there is not even room for "…[truncated]", and emitting a bare suffix would
    // be noise, so the org line falls through and the result is the fail-closed ''.
    const out = buildSourceGuidance([], { orgPrompt: 'y'.repeat(500), budget: 20 })
    expect(out).toBe('')
  })

  it('fails CLOSED (empty string) when the header alone would be misleading', () => {
    // Line 93. If nothing at all landed in `lines`, a bare "[Source guidance]"
    // header with no body would tell the model guidance exists when it does not.
    // Returning '' is the deliberate fail-closed choice.
    const out = buildSourceGuidance([], { orgPrompt: '', budget: 100 })
    expect(out).toBe('')
  })

  it('a ZERO budget yields empty rather than a bare header', () => {
    // budget is clamped with Math.max(0, ...), so 0 and negatives behave alike.
    expect(buildSourceGuidance([{ name: 'd', content: 'c' }], { budget: 0 })).toBe('')
    expect(buildSourceGuidance([{ name: 'd', content: 'c' }], { budget: -50 })).toBe('')
  })

  it('still emits the header when content DID land', () => {
    // The inverse of the fail-closed case, so the two are distinguishable.
    const out = buildSourceGuidance([{ name: 'd', content: 'c' }], { budget: 100 })
    expect(out.startsWith('[Source guidance]')).toBe(true)
  })
})
