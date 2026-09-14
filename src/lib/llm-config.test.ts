import { test, expect, describe, afterEach } from 'bun:test'
import { isBlockedHostAsync, isBlockedHost, normalizeBaseUrl, allowedHosts } from '@/lib/llm-config'

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
  // ---------------------------------------------------------------------------
  // The ASYNC guard, which had NO coverage until this defect was found -- and that
  // absence is precisely why the defect survived.
  //
  // `isBlockedHostAsync` re-applies `isBlockedHost` to the RESOLVED address, and the
  // operator allowlist is keyed on the HOSTNAME. So a host the operator opted in was
  // allowed by the literal check and then blocked by the DNS check, because the name
  // resolves to a private address. Measured before the fix, with
  // LLM_ALLOWED_HOSTS=localhost:
  //
  //   isBlockedHost('localhost')      -> false   (allowlisted, correct)
  //   isBlockedHostAsync('localhost') -> TRUE    (contradicted the allowlist)
  //
  // Every synchronous caller looked right, and the self-hosted topology the module's
  // own comment promises could not be configured at all: the operator saved the host
  // and every request failed with "Base URL points to a blocked internal host", with
  // nothing hinting that the allowlist had been ignored.
  // ---------------------------------------------------------------------------
  describe('isBlockedHostAsync honours the operator allowlist', () => {
    const ORIGINAL = process.env.LLM_ALLOWED_HOSTS
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.LLM_ALLOWED_HOSTS
      else process.env.LLM_ALLOWED_HOSTS = ORIGINAL
    })

    test('REGRESSION: an allowlisted host that resolves to loopback is NOT blocked', async () => {
      process.env.LLM_ALLOWED_HOSTS = 'localhost'
      // The literal check and the DNS check must AGREE. Before the fix the first line
      // passed and the second failed -- the exact contradiction that made the
      // documented topology impossible.
      expect(isBlockedHost('localhost')).toBe(false)
      expect(await isBlockedHostAsync('localhost')).toBe(false)
    })

    test('the allowlist is consulted for the RESOLVED address, not only the literal', async () => {
      // `127.0.0.1` is what `localhost` resolves to; allowing the name must carry over.
      process.env.LLM_ALLOWED_HOSTS = 'localhost'
      expect(await isBlockedHostAsync('localhost')).toBe(false)
      // But the IP is NOT itself allowlisted, so naming it directly is still blocked.
      // Without this the fix would have opened every loopback URL.
      expect(await isBlockedHostAsync('127.0.0.1')).toBe(true)
      // An allowlist entry spelled as the IP works only when it IS the entry.
      process.env.LLM_ALLOWED_HOSTS = '127.0.0.1'
      expect(await isBlockedHostAsync('127.0.0.1')).toBe(false)
    })

    test('NOTHING is allowlisted by default, and private names stay blocked', async () => {
      delete process.env.LLM_ALLOWED_HOSTS
      expect(await isBlockedHostAsync('localhost')).toBe(true)
      expect(await isBlockedHostAsync('127.0.0.1')).toBe(true)
      expect(await isBlockedHostAsync('10.0.0.1')).toBe(true)
      expect(await isBlockedHostAsync('169.254.169.254')).toBe(true)
    })

    test('an allowlisted private NAME is reachable, and a non-allowlisted one is not', async () => {
      process.env.LLM_ALLOWED_HOSTS = 'ollama,embed.internal'
      expect(await isBlockedHostAsync('ollama')).toBe(false)
      expect(await isBlockedHostAsync('embed.internal')).toBe(false)
      // A lookalike is NOT matched by the allowlist -- matching is exact, so `evil-ollama.com`
      // does not ride in on `ollama`. These two names do not RESOLVE in this environment, and a
      // DNS failure deliberately fails OPEN (the transport then tries and fails), so the return is
      // false here. That is the documented behaviour, not a hole: the assertion that matters is
      // that the allowlist did not MATCH them. Asserted that way rather than as `toBe(true)`,
      // which would have been asserting the resolver's absence rather than the guard's decision.
      expect(allowedHosts()).not.toContain('evil-ollama.com')
      expect(allowedHosts()).not.toContain('not-embed.internal')
      // A lookalike that DOES resolve must still be caught by the resolved-address check, and an
      // IP literal cannot dodge it at all because IP literals skip DNS and go to the sync guard.
      expect(await isBlockedHostAsync('127.0.0.1')).toBe(true)
    })

    test('the allowlist does not make a PUBLIC host unreachable', async () => {
      // Guards against a fix that returned false too eagerly: an ordinary public API
      // must still pass with an allowlist configured, or the fix trades one bug for another.
      process.env.LLM_ALLOWED_HOSTS = 'ollama'
      expect(await isBlockedHostAsync('api.openai.com')).toBe(false)
    })
  })

})
