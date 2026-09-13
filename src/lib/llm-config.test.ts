import { test, expect, describe } from 'bun:test'
import { isBlockedHost, normalizeBaseUrl } from '@/lib/llm-config'

describe('isBlockedHost', () => {
  test('blocks loopback, link-local, private, CGNAT ranges', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(true)
    expect(isBlockedHost('127.255.255.255')).toBe(true)
    expect(isBlockedHost('localhost')).toBe(true)
    expect(isBlockedHost('::1')).toBe(true)
    expect(isBlockedHost('::')).toBe(true)
    expect(isBlockedHost('[::1]')).toBe(true)
    expect(isBlockedHost('[::]')).toBe(true)
    expect(isBlockedHost('0.0.0.0')).toBe(true)
    expect(isBlockedHost('169.254.169.254')).toBe(true)
    expect(isBlockedHost('169.254.1.1')).toBe(true)
    expect(isBlockedHost('10.0.0.1')).toBe(true)
    expect(isBlockedHost('10.255.255.255')).toBe(true)
    expect(isBlockedHost('192.168.1.1')).toBe(true)
    expect(isBlockedHost('192.168.0.0')).toBe(true)
    expect(isBlockedHost('172.16.0.1')).toBe(true)
    expect(isBlockedHost('172.31.255.255')).toBe(true)
    expect(isBlockedHost('172.20.5.5')).toBe(true)
    expect(isBlockedHost('100.64.0.1')).toBe(true)
    expect(isBlockedHost('100.127.255.255')).toBe(true)
    expect(isBlockedHost('100.100.50.50')).toBe(true)
  })

  test('blocks IPv6 ULA and link-local prefixes', () => {
    expect(isBlockedHost('fd00::1')).toBe(true)
    expect(isBlockedHost('fd12:3456::1')).toBe(true)
    expect(isBlockedHost('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true)
    expect(isBlockedHost('fe80::1')).toBe(true)
    expect(isBlockedHost('fe90::1')).toBe(true)
    expect(isBlockedHost('fea0::1')).toBe(true)
    expect(isBlockedHost('feb0::1')).toBe(true)
    expect(isBlockedHost('[fe80::1]')).toBe(true)
  })

  test('allows public hosts', () => {
    expect(isBlockedHost('8.8.8.8')).toBe(false)
    expect(isBlockedHost('1.1.1.1')).toBe(false)
    expect(isBlockedHost('172.32.0.1')).toBe(false)
    expect(isBlockedHost('172.15.0.1')).toBe(false)
    expect(isBlockedHost('100.63.0.1')).toBe(false)
    expect(isBlockedHost('100.128.0.1')).toBe(false)
    expect(isBlockedHost('11.0.0.1')).toBe(false)
    expect(isBlockedHost('192.169.1.1')).toBe(false)
    expect(isBlockedHost('example.com')).toBe(false)
    expect(isBlockedHost('2001:4860:4860::8888')).toBe(false)
    expect(isBlockedHost('fc00::1')).toBe(false)
    expect(isBlockedHost('fec0::1')).toBe(false)
  })

  test('is case-insensitive', () => {
    expect(isBlockedHost('LOCALHOST')).toBe(true)
    expect(isBlockedHost('Localhost')).toBe(true)
    expect(isBlockedHost('FD00::1')).toBe(true)
    expect(isBlockedHost('FE80::1')).toBe(true)
  })

  test('blocks IPv4-MAPPED / IPv4-COMPATIBLE IPv6 literals, which are the same address', () => {
    // REGRESSION (found this round in the web-fetch SSRF sweep): `new URL('http://[::ffff:127.0.0.1]/')`
    // canonicalises the host to `[::ffff:7f00:1]`, which matched neither the bare '::1' equality nor any
    // IPv4 regex -- so a request to the cloud metadata service over a v4-MAPPED loopback literal was
    // DIALED. The async guard could not save it either: it skips DNS for hex literals on the assumption
    // that this function already checked them. Both spellings and the canonicalised form are asserted,
    // because a caller can supply either and URL rewrites one into the other.
    for (const h of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '::ffff:169.254.169.254',
      '[::ffff:a9fe:a9fe]',
      '::ffff:10.0.0.1',
      '::127.0.0.1',
      '::7f00:1',
      '::ffff:192.168.1.1',
    ]) {
      expect([h, isBlockedHost(h)], h).toEqual([h, true])
    }
  })

  test('the v4-mapped decode does NOT over-block a public address in the same encoding', () => {
    // Without this control the test above would pass for a guard that blocks every '::ffff:*' literal,
    // which would break a legitimate LLM endpoint published over IPv6.
    for (const h of ['::ffff:8.8.8.8', '::ffff:808:808', '[::ffff:8.8.8.8]', '2001:4860:4860::8888']) {
      expect([h, isBlockedHost(h)], h).toEqual([h, false])
    }
  })

  test('normalizeBaseUrl rejects a v4-mapped metadata literal, not just the bare IPv4 one', () => {
    // The end of the chain that actually builds the baseUrl for a customer-configured LLM endpoint.
    expect(() => normalizeBaseUrl('http://[::ffff:169.254.169.254]/latest/meta-data/')).toThrow(
      /blocked internal host/,
    )
    expect(() => normalizeBaseUrl('http://[::ffff:127.0.0.1]:8080')).toThrow(/blocked internal host/)
  })

  test('normalizeBaseUrl rejects blocked hosts', () => {
    expect(() => normalizeBaseUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      /blocked internal host/,
    )
    expect(() => normalizeBaseUrl('http://127.0.0.1:8080')).toThrow(/blocked internal host/)
    expect(() => normalizeBaseUrl('http://10.0.0.1')).toThrow(/blocked internal host/)
    expect(() => normalizeBaseUrl('http://192.168.1.1')).toThrow(/blocked internal host/)
    expect(() => normalizeBaseUrl('http://localhost:3000')).toThrow(/blocked internal host/)
  })
})
