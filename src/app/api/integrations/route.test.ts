import { describe, expect, test } from 'bun:test'
import { validateCreateIntegrationInput } from './route'

describe('integration create validation', () => {
  test('keeps /api/integrations dedicated to database providers', () => {
    const result = validateCreateIntegrationInput({
      name: 'ERP API',
      type: 'API',
      provider: 'REST_API',
      config: {},
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('/api/data-sources/rest-connectors')
  })
})
