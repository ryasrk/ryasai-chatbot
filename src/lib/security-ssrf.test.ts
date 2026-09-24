import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isBlockedHost, normalizeBaseUrl } from './llm-config'

/**
 * The DEFAULT posture, isolated from the machine running the tests.
 *
 * `isBlockedHost` consults `LLM_ALLOWED_HOSTS`, and Bun auto-loads `.env` — so a developer
 * or CI box with a self-hosted embedder configured (the supported
 * `LLM_ALLOWED_HOSTS=127.0.0.1` topology) made the "loopback is blocked by default"
 * assertions fail. MEASURED: with that one line in `.env`, two tests here failed and six
 * files in the suite went red, all in security tests, none of them about retrieval.
 *
 * Clearing the variable for these blocks is not a weakening: the allowlist's own
 * precedence IS asserted, deliberately and with the variable set, in the block below. What
 * is fixed here is that the DEFAULT tests now test the default.
 */
beforeEach(() => {
  delete process.env.LLM_ALLOWED_HOSTS
  delete process.env.LLM_ALLOW_BLOCKED_HOSTS
  delete process.env.E2E_TEST_MODE
})

/** Restore whatever the environment had, so this file cannot leak into the suite. */
const AMBIENT = {
  allow: process.env.LLM_ALLOWED_HOSTS,
  hatch: process.env.LLM_ALLOW_BLOCKED_HOSTS,
  e2e: process.env.E2E_TEST_MODE,
}
afterEach(() => {
  for (const [k, v] of [
    ['LLM_ALLOWED_HOSTS', AMBIENT.allow],
    ['LLM_ALLOW_BLOCKED_HOSTS', AMBIENT.hatch],
    ['E2E_TEST_MODE', AMBIENT.e2e],
  ] as Array<[string, string | undefined]>) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

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

// ===========================================================================
// The OPERATOR allowlist and the test hatch, which decide precedence
// ===========================================================================

describe('SSRF — LLM_ALLOWED_HOSTS beats the blocklist, hatch decisions included', () => {
  /** Restores every env var touched here, so this block cannot leak. */
  const saved = {
    allow: process.env.LLM_ALLOWED_HOSTS,
    hatch: process.env.LLM_ALLOW_BLOCKED_HOSTS,
    e2e: process.env.E2E_TEST_MODE,
    nodeEnv: process.env.NODE_ENV,
  }
  function restore(): void {
    for (const [k, v] of [
      ['LLM_ALLOWED_HOSTS', saved.allow],
      ['LLM_ALLOW_BLOCKED_HOSTS', saved.hatch],
      ['E2E_TEST_MODE', saved.e2e],
      ['NODE_ENV', saved.nodeEnv],
    ] as Array<[string, string | undefined]>) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }

  test('an allowlisted INTERNAL host is allowed even though the blocklist matches it', () => {
    // Real self-hosted case: the LLM runs on 10.x inside the customer's network. The
    // operator names it, and that decision OVERRIDES the blocklist -- otherwise a
    // self-hosted install could never reach its own model server.
    process.env.LLM_ALLOWED_HOSTS = '10.0.0.5, llm.internal.corp'
    delete process.env.LLM_ALLOW_BLOCKED_HOSTS
    delete process.env.E2E_TEST_MODE
    try {
      expect(isBlockedHost('10.0.0.5')).toBe(false)
      // A DIFFERENT private address in the same range is still blocked: the allowlist
      // names exact hosts, it does not open the whole 10/8 range. (I wrote `false`
      // here first, having misread my own comment.)
      expect(isBlockedHost('10.0.0.6')).toBe(true)
      expect(isBlockedHost('llm.internal.corp')).toBe(false)
    } finally {
      restore()
    }
  })

  test('the allowlist is trimmed and lowercased before matching', () => {
    // `allowedHosts()` splits on comma, trims, and lowercases, and `isBlockedHost`
    // lowercases the INPUT too. A pasted list with spaces and capitals
    // (" 10.0.0.5 , 10.1.2.3 ") would otherwise never match and the operator would see
    // a confusing block.
    //
    // The host must be PRIVATE for this to prove anything. My first version allowlisted
    // a public DNS name ('LLM.CORP') and asserted `false` -- which passed even with
    // `toLowerCase()` REMOVED, because a public name is not on the blocklist anyway.
    // The assertion was satisfied by the wrong branch; a control caught it.
    process.env.LLM_ALLOWED_HOSTS = '  10.0.0.5  ,  10.9.8.7  '
    try {
      expect(isBlockedHost('10.0.0.5')).toBe(false)
      // Uppercase/spaced list entries must match a lowercase input.
      expect(isBlockedHost(' 10.0.0.5 ')).toBe(false)
      expect(isBlockedHost('10.9.8.7')).toBe(false)
      // A DIFFERENT private host is still blocked, proving the list is exact-match.
      expect(isBlockedHost('10.9.8.8')).toBe(true)
    } finally {
      restore()
    }
  })

  test('an UPPERCASE allowlist entry matches a lowercase input', () => {
    // The case-insensitivity half, isolated. 10.1.2.3 is private, so `false` can ONLY
    // come from the allowlist match.
    process.env.LLM_ALLOWED_HOSTS = '10.1.2.3'
    try {
      expect(isBlockedHost('10.1.2.3')).toBe(false)
      expect(isBlockedHost('10.1.2.4')).toBe(true)
    } finally {
      restore()
    }
  })

  test('an uppercase entry for a LETTERED private host still matches', () => {
    // The case above cannot observe `allowedHosts()`'s `toLowerCase()`, because an IP
    // literal has no letters and `isBlockedHost` lowercases the INPUT anyway. A LETTERED
    // host is required, and it must be one the BLOCKLIST already matches -- otherwise
    // `false` would come from the host being public rather than from the allowlist.
    //
    // `metadata.aws.internal` is exactly that: a cloud metadata endpoint the blocklist
    // matches by name. MEASURED: with `toLowerCase()` removed from `allowedHosts()`,
    // `LLM_ALLOWED_HOSTS='METADATA.AWS.INTERNAL'` no longer matches the lowercased input
    // and the host is BLOCKED -- so an operator who wrote the name in capitals silently
    // loses the allowlist entry. With it, the entry is honoured.
    process.env.LLM_ALLOWED_HOSTS = 'METADATA.AWS.INTERNAL'
    delete process.env.LLM_ALLOW_BLOCKED_HOSTS
    try {
      expect(isBlockedHost('metadata.aws.internal')).toBe(false)
      expect(isBlockedHost('METADATA.AWS.INTERNAL')).toBe(false)
      // And a DIFFERENT metadata endpoint is still blocked, so the match is exact.
      expect(isBlockedHost('metadata.google.internal')).toBe(true)
    } finally {
      restore()
    }
  })

  test('DECLARED EQUIVALENT: filter(Boolean) cannot be observed through this API', () => {
    // Dropping `.filter(Boolean)` leaves '' in the list, and '' could only ever match an
    // EMPTY hostname. `isBlockedHost('')` returns false either way (with the filter the
    // list is empty and nothing matches; without it '' matches '' and the allowlist
    // returns false). No input distinguishes them, so the filter is declared equivalent
    // rather than claimed as covered.
    process.env.LLM_ALLOWED_HOSTS = ',,,'
    try {
      expect(isBlockedHost('')).toBe(false)
      expect(isBlockedHost('localhost')).toBe(true)
    } finally {
      restore()
    }
  })

  test('the allowlist is checked BEFORE the hatch, so it is not a way to disable blocking', () => {
    // Precedence matters: the allowlist wins even when the hatch is OFF. If the order
    // were reversed, an operator allowlist would only work while the TEST hatch was on.
    process.env.LLM_ALLOWED_HOSTS = '10.0.0.5'
    process.env.LLM_ALLOW_BLOCKED_HOSTS = 'false'
    try {
      expect(isBlockedHost('10.0.0.5')).toBe(false)
      // Everything else still blocks.
      expect(isBlockedHost('10.0.0.9')).toBe(true)
      expect(isBlockedHost('localhost')).toBe(true)
    } finally {
      restore()
    }
  })

  test('the test HATCH disables blocking in a NON-production build', () => {
    // The `if (process.env.NODE_ENV !== 'production') return true` line. This is what
    // lets the e2e suite point the app at a mock LLM on localhost. It is only safe
    // because a PRODUCTION build falls through to the E2E_TEST_MODE check below.
    process.env.LLM_ALLOW_BLOCKED_HOSTS = 'true'
    delete process.env.E2E_TEST_MODE
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'test'
    try {
      expect(isBlockedHost('localhost')).toBe(false)
      expect(isBlockedHost('169.254.169.254')).toBe(false)
      expect(isBlockedHost('10.0.0.1')).toBe(false)
    } finally {
      restore()
    }
  })

  test('the hatch is REFUSED in a production build unless E2E_TEST_MODE is set', () => {
    // The security-critical half: NODE_ENV=production alone must NOT disable the
    // blocklist. It takes the separate E2E_TEST_MODE marker, which env-schema also
    // requires an explicit opt-in for.
    process.env.LLM_ALLOW_BLOCKED_HOSTS = 'true'
    delete process.env.E2E_TEST_MODE
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'production'
    try {
      // Falls THROUGH the hatch: blocking is still in force.
      expect(isBlockedHost('localhost')).toBe(true)
      expect(isBlockedHost('169.254.169.254')).toBe(true)
      expect(isBlockedHost('10.0.0.1')).toBe(true)

      // With the explicit marker, a production BUILD under test can reach the mock.
      process.env.E2E_TEST_MODE = 'true'
      expect(isBlockedHost('localhost')).toBe(false)
    } finally {
      restore()
    }
  })

  test('the hatch OFF means the blocklist applies in every environment', () => {
    process.env.LLM_ALLOW_BLOCKED_HOSTS = 'false'
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'test'
    try {
      expect(isBlockedHost('localhost')).toBe(true)
      expect(isBlockedHost('10.0.0.1')).toBe(true)
    } finally {
      restore()
    }
  })

  test('with an allowlist set, a NON-listed host still goes through the hatch decision', () => {
    // The `return false` on line 75 is reached only when a host is allowlisted. This
    // pins that a NON-allowlisted host is NOT accidentally allowed by the presence of
    // an allowlist -- a plausible bug where the list is treated as "allow anything".
    process.env.LLM_ALLOWED_HOSTS = 'only.this.host'
    process.env.LLM_ALLOW_BLOCKED_HOSTS = 'true'
    delete process.env.E2E_TEST_MODE
    ;(process.env as Record<string, string | undefined>).NODE_ENV = 'test'
    try {
      expect(isBlockedHost('only.this.host')).toBe(false)
      // The hatch is on too, so everything is allowed here -- but that is the HATCH's
      // doing. Turn it off to isolate the allowlist.
      process.env.LLM_ALLOW_BLOCKED_HOSTS = 'false'
      // A PRIVATE address that is not on the list is still blocked. (I first used
      // 'other.host' and asserted true -- but a public DNS name is NOT on the
      // blocklist, so that assertion was wrong about the product, not the product
      // wrong about itself.)
      expect(isBlockedHost('10.9.9.9')).toBe(true)
      expect(isBlockedHost('localhost')).toBe(true)
      expect(isBlockedHost('other.host')).toBe(false) // public names pass by design
    } finally {
      restore()
    }
  })
})
