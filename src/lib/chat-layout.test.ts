import { describe, expect, test } from 'bun:test'
import { citationDetailLabel, chatSessionPanelWidthClass, chatShellGridClass } from './chat-layout'

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
