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
