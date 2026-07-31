import { describe, expect, test } from 'bun:test'

process.env.SAML_SP_ENTITY_ID = 'https://chatbot.test'
process.env.SAML_SP_CALLBACK_URL = 'https://chatbot.test/api/auth/saml/callback'
process.env.SAML_IDP_ENTRY_POINT = 'https://idp.test/saml/sso'
process.env.SAML_IDP_CERT = '-----BEGIN CERTIFICATE-----\nMIIDfakecert\n-----END CERTIFICATE-----'
process.env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)

import {
  isSamlConfigured,
  buildSamlConfig,
  generateSpMetadata,
} from './sso-saml'

describe('isSamlConfigured', () => {
  test('returns true when all required env vars are set', () => {
    expect(isSamlConfigured()).toBe(true)
  })

  test('returns false when SAML_SP_ENTITY_ID is missing', () => {
    const saved = process.env.SAML_SP_ENTITY_ID
    delete process.env.SAML_SP_ENTITY_ID
    expect(isSamlConfigured()).toBe(false)
    process.env.SAML_SP_ENTITY_ID = saved
  })

  test('returns false when SAML_SP_CALLBACK_URL is missing', () => {
    const saved = process.env.SAML_SP_CALLBACK_URL
    delete process.env.SAML_SP_CALLBACK_URL
    expect(isSamlConfigured()).toBe(false)
    process.env.SAML_SP_CALLBACK_URL = saved
  })

  test('returns true with only metadata URL (no manual entryPoint)', () => {
    const savedEntry = process.env.SAML_IDP_ENTRY_POINT
    const savedCert = process.env.SAML_IDP_CERT
    delete process.env.SAML_IDP_ENTRY_POINT
    delete process.env.SAML_IDP_CERT
    process.env.SAML_IDP_METADATA_URL = 'https://idp.test/metadata'
    expect(isSamlConfigured()).toBe(true)
    delete process.env.SAML_IDP_METADATA_URL
    process.env.SAML_IDP_ENTRY_POINT = savedEntry
    process.env.SAML_IDP_CERT = savedCert
  })

  test('returns false when neither entryPoint nor metadata URL set', () => {
    const savedEntry = process.env.SAML_IDP_ENTRY_POINT
    const savedMeta = process.env.SAML_IDP_METADATA_URL
    delete process.env.SAML_IDP_ENTRY_POINT
    delete process.env.SAML_IDP_METADATA_URL
    expect(isSamlConfigured()).toBe(false)
    process.env.SAML_IDP_ENTRY_POINT = savedEntry
    if (savedMeta) process.env.SAML_IDP_METADATA_URL = savedMeta
  })

  test('returns false when env var is whitespace only', () => {
    const saved = process.env.SAML_SP_ENTITY_ID
    process.env.SAML_SP_ENTITY_ID = '   '
    expect(isSamlConfigured()).toBe(false)
    process.env.SAML_SP_ENTITY_ID = saved
  })
})

describe('buildSamlConfig', () => {
  test('builds correct config from env vars', () => {
    const cfg = buildSamlConfig()
    expect(cfg.issuer).toBe('https://chatbot.test')
    expect(cfg.callbackUrl).toBe('https://chatbot.test/api/auth/saml/callback')
    expect(cfg.entryPoint).toBe('https://idp.test/saml/sso')
    expect(cfg.cert).toBe('-----BEGIN CERTIFICATE-----\nMIIDfakecert\n-----END CERTIFICATE-----')
  })

  test('throws when no entry point and no metadata URL', () => {
    const savedEntry = process.env.SAML_IDP_ENTRY_POINT
    const savedMeta = process.env.SAML_IDP_METADATA_URL
    delete process.env.SAML_IDP_ENTRY_POINT
    delete process.env.SAML_IDP_METADATA_URL
    expect(() => buildSamlConfig()).toThrow('SAML_IDP_ENTRY_POINT or SAML_IDP_METADATA_URL')
    process.env.SAML_IDP_ENTRY_POINT = savedEntry
    if (savedMeta) process.env.SAML_IDP_METADATA_URL = savedMeta
  })
})

describe('generateSpMetadata', () => {
  test('returns valid XML with correct entityID', () => {
    const xml = generateSpMetadata()
    expect(xml).toContain('<EntityDescriptor')
    expect(xml).toContain('https://chatbot.test')
    expect(xml).toContain('AssertionConsumerService')
    expect(xml).toContain('https://chatbot.test/api/auth/saml/callback')
  })
})
