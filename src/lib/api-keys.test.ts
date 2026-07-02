import { describe, expect, test } from 'bun:test'
import { generateApiKey, hashApiKey, maskApiKey, verifyApiKey } from './api-keys'

describe('api key utilities', () => {
  test('generates a ryas-prefixed key with prefix and hash', () => {
    const key = generateApiKey()

    expect(key.plainText.startsWith('ryas_')).toBe(true)
    expect(key.prefix.startsWith('ryas_')).toBe(true)
    expect(key.hash).not.toContain(key.plainText)
  })

  test('verifies only the matching key', () => {
    const plain = 'ryas_test_key_123'
    const hash = hashApiKey(plain)

    expect(verifyApiKey(plain, hash)).toBe(true)
    expect(verifyApiKey('ryas_wrong_key_123', hash)).toBe(false)
  })

  test('masks by prefix', () => {
    expect(maskApiKey('ryas_abc12345')).toBe('ryas_abc12345...')
  })
})
