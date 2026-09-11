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
