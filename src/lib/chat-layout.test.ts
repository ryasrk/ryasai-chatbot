import { describe, expect, test } from 'bun:test'
import {
  citationDetailLabel,
  citationRankLabel,
  chatSessionPanelWidthClass,
  chatShellGridClass,
} from './chat-layout'

describe('chat layout helpers', () => {
  test('collapses the session sidebar into a rail that gives space back to chat', () => {
    expect(chatShellGridClass()).toContain('auto')
    expect(chatSessionPanelWidthClass(false)).toContain('clamp(200px,18vw,260px)')
    expect(chatSessionPanelWidthClass(true)).toContain('w-12')
  })

  test('uses source detail label for document citations', () => {
    expect(citationDetailLabel('DOCUMENT')).toBe('View source details')
    expect(citationDetailLabel('DATABASE')).toBe('View SQL query')
  })
})

describe('the citation badge reports a rank, not a confidence', () => {
  test('a fused RRF score never becomes a percentage', () => {
    // The measured values production actually produces. Before this helper the badge
    // rendered `Math.round(score * 100)`, so the BEST possible citation — found by
    // both legs at rank 1 — displayed "3% relevance".
    const best = 1 / 61 + 1 / 61
    const label = citationRankLabel(0, best)
    expect(label).toBe('Match #1')
    expect(label).not.toContain('%')
    // And the number it would have shown, for the record: 3.
    expect(Math.round(best * 100)).toBe(3)
  })

  test('the label follows position, not the magnitude of the score', () => {
    // Two documents at adjacent ranks have nearly identical fused scores, so a
    // magnitude-derived label would show both as the same percentage — which is
    // exactly the information loss this replaces.
    const first = citationRankLabel(0, 0.0328)
    const second = citationRankLabel(1, 0.0327)
    expect(first).toBe('Match #1')
    expect(second).toBe('Match #2')
  })

  test('a citation with no score renders no badge', () => {
    // DATABASE citations carry no score; "Match #0" would be a fabrication.
    expect(citationRankLabel(0, undefined)).toBeNull()
    expect(citationRankLabel(0, null)).toBeNull()
    expect(citationRankLabel(0, Number.NaN)).toBeNull()
  })

  test('a zero score still labels — a real rank with a small score is not "missing"', () => {
    // Guarding on falsiness instead of type would blank the badge for any document
    // whose fused score rounded to 0, which is most of a long tail.
    expect(citationRankLabel(4, 0)).toBe('Match #5')
  })
})
