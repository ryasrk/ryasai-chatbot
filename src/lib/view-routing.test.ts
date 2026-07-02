import { describe, expect, test } from 'bun:test'
import { resolveViewFromSearch } from './view-routing'

describe('view routing', () => {
  test('resolves known view from query string and falls back safely', () => {
    expect(resolveViewFromSearch('?view=chat')).toBe('chat')
    expect(resolveViewFromSearch('?view=integrations')).toBe('integrations')
    expect(resolveViewFromSearch('?view=unknown')).toBe('dashboard')
    expect(resolveViewFromSearch('')).toBe('dashboard')
  })
})
