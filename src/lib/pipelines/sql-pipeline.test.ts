import { afterEach, describe, expect, test } from 'bun:test'
import { buildCrossSourceNote, forbiddenSourceMessage, sqlRateLimitPerMinute, withIntegrationContextPrompt } from './sql-pipeline'

describe('sqlRateLimitPerMinute', () => {
  const saved = process.env.TOOL_RATE_LIMIT_SQL_PER_MINUTE
  afterEach(() => {
    if (saved === undefined) delete process.env.TOOL_RATE_LIMIT_SQL_PER_MINUTE
    else process.env.TOOL_RATE_LIMIT_SQL_PER_MINUTE = saved
  })

  test('defaults to 10, the limit the non-streaming path always had', () => {
    delete process.env.TOOL_RATE_LIMIT_SQL_PER_MINUTE
    expect(sqlRateLimitPerMinute()).toBe(10)
  })

  test('an operator can raise it', () => {
    process.env.TOOL_RATE_LIMIT_SQL_PER_MINUTE = '120'
    expect(sqlRateLimitPerMinute()).toBe(120)
  })

  test.each(['0', '-5', 'abc', '2.5', ''])('an invalid value %p falls back to the default, never to unlimited', (v) => {
    process.env.TOOL_RATE_LIMIT_SQL_PER_MINUTE = v
    expect(sqlRateLimitPerMinute()).toBe(10)
  })
})

describe('prompt helpers', () => {
  test('the integration contextPrompt is appended and capped at 2000 characters', () => {
    expect(withIntegrationContextPrompt('Base.', 'Fiscal year starts in April.')).toBe('Base.\n\nContext guidance:\nFiscal year starts in April.')
    expect(withIntegrationContextPrompt(undefined, '  ')).toBeUndefined()
    expect(withIntegrationContextPrompt(undefined, 'x'.repeat(3000))!.length).toBe('Context guidance:\n'.length + 2000)
  })

  test('the cross-source note names only the OTHER sources, and is empty for a single source', () => {
    const note = buildCrossSourceNote('Sales', ['Sales', 'HR'])
    expect(note).toContain('Other connected data sources in this workspace: HR.')
    expect(note).not.toContain('sources in this workspace: Sales')
    expect(buildCrossSourceNote('Sales', ['Sales'])).toBe('')
  })

  test('the access-denied message names the source but no table', () => {
    expect(forbiddenSourceMessage('HR')).toBe('Your role does not have access to the data in HR. Ask an administrator to grant access to the tables you need.')
  })
})
