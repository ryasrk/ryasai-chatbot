import { describe, expect, test } from 'bun:test'
import { isBlockedHost, normalizeBaseUrl } from './llm-config'

describe('SSRF — IP bypass attempts', () => {
  describe('RFC1918 private ranges', () => {
    test('10.x.x.x → blocked', () => {
      expect(isBlockedHost('10.0.0.1')).toBe(true)
      expect(isBlockedHost('10.255.255.255')).toBe(true)
      expect(isBlockedHost('10.1.2.3')).toBe(true)
    })

    test('172.16-31.x.x → blocked', () => {
      expect(isBlockedHost('172.16.0.1')).toBe(true)
      expect(isBlockedHost('172.31.255.255')).toBe(true)
      expect(isBlockedHost('172.20.5.5')).toBe(true)
    })

    test('172.32.x.x → NOT blocked (public range)', () => {
      expect(isBlockedHost('172.32.0.1')).toBe(false)
      expect(isBlockedHost('172.15.0.1')).toBe(false)
    })

    test('192.168.x.x → blocked', () => {
      expect(isBlockedHost('192.168.0.1')).toBe(true)
      expect(isBlockedHost('192.168.1.100')).toBe(true)
    })
  })

  describe('link-local (169.254.x.x)', () => {
    test('AWS metadata endpoint → blocked', () => {
      expect(isBlockedHost('169.254.169.254')).toBe(true)
      expect(isBlockedHost('169.254.169.254')).toBe(true)
    })

    test('GCP metadata endpoint → blocked', () => {
      expect(isBlockedHost('metadata.google.internal')).toBe(true)
      expect(isBlockedHost('metadata.aws.internal')).toBe(true)
      expect(isBlockedHost('metadata.azure.com')).toBe(true)
    })
  })

  describe('CGNAT (100.64/10)', () => {
    test('100.64-127.x.x → blocked', () => {
      expect(isBlockedHost('100.64.0.1')).toBe(true)
      expect(isBlockedHost('100.100.100.100')).toBe(true)
      expect(isBlockedHost('100.127.255.255')).toBe(true)
    })

    test('100.128.x.x → NOT blocked', () => {
      expect(isBlockedHost('100.128.0.1')).toBe(false)
    })
  })

  describe('IPv6', () => {
    test('::1 (loopback) → blocked', () => {
      expect(isBlockedHost('::1')).toBe(true)
      expect(isBlockedHost('[::1]')).toBe(true)
    })

    test(':: (unspecified) → blocked', () => {
      expect(isBlockedHost('::')).toBe(true)
      expect(isBlockedHost('[::]')).toBe(true)
    })

    test('IPv6 ULA (fd00::/8) → blocked', () => {
      expect(isBlockedHost('fd00::1')).toBe(true)
      expect(isBlockedHost('fd12:3456::1')).toBe(true)
    })

    test('IPv6 link-local (fe80::/10) → blocked', () => {
      expect(isBlockedHost('fe80::1')).toBe(true)
      expect(isBlockedHost('fe90::1')).toBe(true)
      expect(isBlockedHost('fea0::1')).toBe(true)
      expect(isBlockedHost('feb0::1')).toBe(true)
    })

    test('IPv6 public → NOT blocked', () => {
      expect(isBlockedHost('2606:4700::1')).toBe(false)
    })
  })

  describe('localhost variants', () => {
    test('localhost → blocked', () => {
      expect(isBlockedHost('localhost')).toBe(true)
      expect(isBlockedHost('LOCALHOST')).toBe(true)
      expect(isBlockedHost('Localhost')).toBe(true)
    })

    test('0.0.0.0 → blocked', () => {
      expect(isBlockedHost('0.0.0.0')).toBe(true)
    })

    test('127.x.x.x (entire loopback) → blocked', () => {
      expect(isBlockedHost('127.0.0.1')).toBe(true)
      expect(isBlockedHost('127.0.0.2')).toBe(true)
      expect(isBlockedHost('127.255.255.255')).toBe(true)
      expect(isBlockedHost('127.1.1.1')).toBe(true)
    })
  })

  describe('public IPs → allowed', () => {
    test('8.8.8.8 → allowed', () => {
      expect(isBlockedHost('8.8.8.8')).toBe(false)
    })

    test('1.1.1.1 → allowed', () => {
      expect(isBlockedHost('1.1.1.1')).toBe(false)
    })

    test('example.com → allowed', () => {
      expect(isBlockedHost('example.com')).toBe(false)
    })
  })
})

describe('SSRF — normalizeBaseUrl rejects internal hosts', () => {
  test('http://localhost:11434 → throws', () => {
    expect(() => normalizeBaseUrl('http://localhost:11434')).toThrow()
  })

  test('http://127.0.0.1:8080 → throws', () => {
    expect(() => normalizeBaseUrl('http://127.0.0.1:8080')).toThrow()
  })

  test('http://169.254.169.254 → throws', () => {
    expect(() => normalizeBaseUrl('http://169.254.169.254')).toThrow()
  })

  test('http://10.0.0.1 → throws', () => {
    expect(() => normalizeBaseUrl('http://10.0.0.1')).toThrow()
  })

  test('https://api.openai.com → allowed', () => {
    expect(() => normalizeBaseUrl('https://api.openai.com')).not.toThrow()
  })

  test('file:// protocol → throws', () => {
    expect(() => normalizeBaseUrl('file:///etc/passwd')).toThrow()
  })

  test('ftp:// protocol → throws', () => {
    expect(() => normalizeBaseUrl('ftp://evil.com')).toThrow()
  })
})
