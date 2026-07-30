import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockSessionFindUnique = mock<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
  async () => ({ id: 's1', title: 'Test Session', createdAt: new Date('2026-01-01T00:00:00Z') }),
)
const mockMessageFindMany = mock<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(
  async () => [],
)

mock.module('@/lib/db', () => ({
  db: {
    chatSession: { findUnique: mockSessionFindUnique },
    chatMessage: { findMany: mockMessageFindMany },
  },
}))

import { exportSession } from './conversation-export'

beforeEach(() => {
  mockSessionFindUnique.mockImplementation(async () => ({
    id: 's1',
    title: 'Test Session',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }))
  mockMessageFindMany.mockImplementation(async () => [
    {
      id: 'm1',
      sender: 'user',
      text: 'How many users are there?',
      createdAt: new Date('2026-01-01T00:00:01Z'),
      citations: null,
      toolRuns: [],
    },
    {
      id: 'm2',
      sender: 'ai',
      text: 'There are 42 users. Query: select count(*) from users;',
      createdAt: new Date('2026-01-01T00:00:05Z'),
      citations: JSON.stringify([{ name: 'Users DB' }]),
      toolRuns: [
        { type: 'SQL', status: 'success', latencyMs: 120, inputSummary: '', outputSummary: '' },
      ],
    },
  ])
})

describe('exportSession — JSON', () => {
  test('returns structured JSON with session + messages', async () => {
    const out = await exportSession('s1', 'json')
    const parsed = JSON.parse(out)
    expect(parsed.session.title).toBe('Test Session')
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0].role).toBe('user')
    expect(parsed.messages[1].role).toBe('ai')
    expect(parsed.messages[1].toolRuns).toHaveLength(1)
    expect(parsed.messages[1].toolRuns[0].type).toBe('SQL')
    expect(parsed.messages[1].citations).toEqual([{ name: 'Users DB' }])
  })

  test('empty session still has session object', async () => {
    mockMessageFindMany.mockImplementation(async () => [])
    const out = await exportSession('s1', 'json')
    const parsed = JSON.parse(out)
    expect(parsed.session.id).toBe('s1')
    expect(parsed.messages).toEqual([])
  })

  test('invalid citations JSON becomes empty array', async () => {
    mockMessageFindMany.mockImplementation(async () => [
      { id: 'm1', sender: 'ai', text: 'hi', createdAt: new Date('2026-01-01'), citations: 'not-json', toolRuns: [] },
    ])
    const out = await exportSession('s1', 'json')
    const parsed = JSON.parse(out)
    expect(parsed.messages[0].citations).toEqual([])
  })
})

describe('exportSession — markdown', () => {
  test('produces headers per message with role labels', async () => {
    const out = await exportSession('s1', 'markdown')
    expect(out).toContain('# Test Session')
    expect(out).toContain('## User')
    expect(out).toContain('## Assistant')
  })

  test('wraps SQL in code blocks', async () => {
    const out = await exportSession('s1', 'markdown')
    expect(out).toContain('```sql')
    expect(out).toContain('select count(*) from users')
  })

  test('includes tool runs and citation footnotes', async () => {
    const out = await exportSession('s1', 'markdown')
    expect(out).toContain('**Tool runs:**')
    expect(out).toContain('`SQL` — success (120ms)')
    expect(out).toContain('[^1]: Users DB')
  })

  test('empty session produces header only', async () => {
    mockMessageFindMany.mockImplementation(async () => [])
    const out = await exportSession('s1', 'markdown')
    expect(out).toContain('# Test Session')
    expect(out).not.toContain('## User')
    expect(out).not.toContain('## Assistant')
  })
})

describe('exportSession — errors', () => {
  test('throws when session not found', async () => {
    mockSessionFindUnique.mockImplementation(async () => null)
    expect(exportSession('missing', 'json')).rejects.toThrow(/Session not found/)
  })
})
