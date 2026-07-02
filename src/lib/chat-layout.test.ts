import { describe, expect, test } from 'bun:test'
import { citationDetailLabel, chatSessionPanelWidthClass, chatShellGridClass } from './chat-layout'

describe('chat layout helpers', () => {
  test('collapses the session sidebar into a rail that gives space back to chat', () => {
    expect(chatShellGridClass()).toContain('auto')
    expect(chatSessionPanelWidthClass(false)).toContain('clamp(280px,24vw,360px)')
    expect(chatSessionPanelWidthClass(true)).toContain('w-16')
  })

  test('uses source detail label for document citations', () => {
    expect(citationDetailLabel('DOCUMENT')).toBe('Lihat detail sumber')
    expect(citationDetailLabel('DATABASE')).toBe('Lihat kueri SQL')
  })
})
