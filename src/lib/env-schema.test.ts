import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  validateEnv,
  resetEnvValidation,
  collectOptionalEnvWarnings,
  formatEnvWarningBlock,
  shouldRefuseBootForTestMode,
} from './env-schema'

const env = process.env as Record<string, string | undefined>

// ponytail: `Object.assign(env, snapshot)` restores keys the test overwrote but
// cannot remove keys it *added* — AUTH_DEMO_FALLBACK leaked out of its own test
// and made the later "no warnings" case fail. Delete the extras, then restore.
function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const k of Object.keys(env)) {
    if (!(k in snapshot)) delete env[k]
  }
  Object.assign(env, snapshot)
}

// ponytail: bun auto-loads the developer's .env, so REDIS_URL / DATABASE_URL /
// ENCRYPTION_SECRET_KEY may or may not be present depending on environment.
// Required-var tests pin both explicitly; warning-free tests also silence the
// optional-var warnings so assertions are deterministic on any machine.
function setRequired() {
  env.NODE_ENV = 'production'
  env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)
  env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
}

// ponytail: values must ALSO satisfy each var's zod shape (REDIS_URL is a url),
// so these tests use realistic placeholders instead of a blanket 'set'.
function setOptionalsValid() {
  env.REDIS_URL = 'redis://localhost:6379'
  env.MIDTRANS_SERVER_KEY = 'k'
  env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY = 'c'
  env.LICENSE_INTERNAL_SECRET = 's'
  env.LICENSE_SIGNING_PUBLIC_KEY = 'p'
}

function deleteOptionalWarnVars() {
  delete env.REDIS_URL
  delete env.MIDTRANS_SERVER_KEY
  delete env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY
  delete env.LICENSE_INTERNAL_SECRET
  delete env.LICENSE_SIGNING_PUBLIC_KEY
}

beforeEach(() => {
  resetEnvValidation()
})

afterEach(() => {
  resetEnvValidation()
})

describe('env-schema — collectOptionalEnvWarnings (pure)', () => {
  test('all vars set → no warnings', () => {
    const w = collectOptionalEnvWarnings({
      REDIS_URL: 'redis://localhost:6379',
      MIDTRANS_SERVER_KEY: 'k',
      NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: 'c',
      LICENSE_INTERNAL_SECRET: 's',
      LICENSE_SIGNING_PUBLIC_KEY: 'p',
    })
    expect(w).toEqual([])
  })

  test('everything unset → one warning per degraded feature', () => {
    const w = collectOptionalEnvWarnings({})
    expect(w.length).toBe(5)
    expect(w.some((x) => x.includes('REDIS_URL'))).toBe(true)
    expect(w.some((x) => x.includes('MIDTRANS_SERVER_KEY'))).toBe(true)
    expect(w.some((x) => x.includes('NEXT_PUBLIC_MIDTRANS_CLIENT_KEY'))).toBe(true)
    expect(w.some((x) => x.includes('LICENSE_INTERNAL_SECRET'))).toBe(true)
    expect(w.some((x) => x.includes('LICENSE_SIGNING_PUBLIC_KEY'))).toBe(true)
  })

  test('partial config → only the missing ones warn', () => {
    const w = collectOptionalEnvWarnings({ REDIS_URL: 'redis://r:6379' })
    expect(w.length).toBe(4)
    expect(w.some((x) => x.includes('REDIS_URL'))).toBe(false)
  })

  test('formatEnvWarningBlock renders a single consolidated block', () => {
    const block = formatEnvWarningBlock(['w1', 'w2'])
    const lines = block.split('\n')
    expect(lines.filter((l) => l.includes('⚠️'))).toHaveLength(1)
    expect(block).toContain('• w1')
    expect(block).toContain('• w2')
  })
})

describe('env-schema — validateEnv', () => {
  test('dev mode with required vars set → validates, no fatal error', () => {
    const original = { ...env }
    env.NODE_ENV = 'development'
    env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)
    // dev tolerates unset optionals without failing — just assert no throw
    validateEnv()
    restoreEnv(original)
  })

  test('test mode → skipped entirely (no validation, no warnings)', () => {
    const original = { ...env }
    env.NODE_ENV = 'test'
    delete env.DATABASE_URL
    delete env.ENCRYPTION_SECRET_KEY
    const { warnings } = validateEnv()
    expect(warnings).toEqual([])
    restoreEnv(original)
  })

  test('missing DATABASE_URL → throws even outside production (boot-fatal tier)', () => {
    const original = { ...env }
    env.NODE_ENV = 'development'
    delete env.DATABASE_URL
    env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)
    expect(() => validateEnv()).toThrow(/DATABASE_URL/)
    restoreEnv(original)
  })

  test('missing ENCRYPTION_SECRET_KEY → throws even outside production', () => {
    const original = { ...env }
    env.NODE_ENV = 'development'
    env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    delete env.ENCRYPTION_SECRET_KEY
    expect(() => validateEnv()).toThrow(/ENCRYPTION_SECRET_KEY/)
    restoreEnv(original)
  })

  test('production with valid env and all optionals → no warnings', () => {
    const original = { ...env }
    setRequired()
    setOptionalsValid()
    delete env.AUTH_DEMO_FALLBACK
    const { warnings } = validateEnv()
    expect(warnings).toEqual([])
    restoreEnv(original)
  })

  test('production with short key → warning', () => {
    const original = { ...env }
    env.NODE_ENV = 'production'
    env.ENCRYPTION_SECRET_KEY = 'shortkey'
    env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    setOptionalsValid()
    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes('shorter than 32'))).toBe(true)
    restoreEnv(original)
  })

  test('production with placeholder key → warning', () => {
    const original = { ...env }
    env.NODE_ENV = 'production'
    env.ENCRYPTION_SECRET_KEY = 'testkey12345678'
    env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    setOptionalsValid()
    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes('placeholder'))).toBe(true)
    restoreEnv(original)
  })

  test('production with AUTH_DEMO_FALLBACK=true → warning', () => {
    const original = { ...env }
    setRequired()
    setOptionalsValid()
    env.AUTH_DEMO_FALLBACK = 'true'
    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes('AUTH_DEMO_FALLBACK'))).toBe(true)
    restoreEnv(original)
  })

  test('production with missing optional billing/license vars → consolidated degradation warnings', () => {
    const original = { ...env }
    setRequired()
    delete env.AUTH_DEMO_FALLBACK
    deleteOptionalWarnVars()
    const { warnings } = validateEnv()
    expect(warnings.length).toBeGreaterThanOrEqual(5)
    expect(warnings.some((w) => w.includes('MIDTRANS_SERVER_KEY'))).toBe(true)
    expect(warnings.some((w) => w.includes('LICENSE_SIGNING_PUBLIC_KEY'))).toBe(true)
    restoreEnv(original)
  })

  test('production with missing ENCRYPTION_SECRET_KEY → throws', () => {
    const original = { ...env }
    env.NODE_ENV = 'production'
    delete env.ENCRYPTION_SECRET_KEY
    env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    expect(() => validateEnv()).toThrow()
    restoreEnv(original)
  })

  test('production with invalid optional var value → schema throws', () => {
    const original = { ...env }
    setRequired()
    env.MIDTRANS_IS_PRODUCTION = 'maybe'
    expect(() => validateEnv()).toThrow(/MIDTRANS_IS_PRODUCTION/)
    restoreEnv(original)
  })

  test('production with CONTEXTUAL_RETRIEVAL + RAG_LLM_RERANK accepted (true/false)', () => {
    const original = { ...env }
    setRequired()
    setOptionalsValid()
    env.CONTEXTUAL_RETRIEVAL = 'true'
    env.RAG_LLM_RERANK = 'false'
    const { warnings } = validateEnv()
    expect(warnings).toEqual([])
    restoreEnv(original)
  })

  test('idempotent — calling twice returns same warnings', () => {
    const original = { ...env }
    setRequired()
    setOptionalsValid()
    const r1 = validateEnv()
    const r2 = validateEnv()
    expect(r2.warnings).toEqual(r1.warnings)
    restoreEnv(original)
  })

  test('resetEnvValidation allows re-validation', () => {
    const original = { ...env }
    setRequired()
    setOptionalsValid()
    validateEnv()
    resetEnvValidation()
    validateEnv()
    restoreEnv(original)
  })
})

// ---------------------------------------------------------------------------
// SSRF hatch + E2E_TEST_MODE
// ---------------------------------------------------------------------------
// `LLM_ALLOW_BLOCKED_HOSTS=true` disables isBlockedHost() (llm-config.ts), which
// is the guard stopping the LLM configured endpoint and REST connectors from
// reaching cloud metadata IPs and internal ranges. It exists ONLY so the test
// suite can talk to the localhost mock LLM.
//
// INCIDENT (2026-09): the prod-build e2e suite (`playwright.prod.config.ts`,
// NODE_ENV=production + standalone server.js) could not boot at all because
// this rule refused the flag — so the artifact we actually ship was the one
// artifact with no e2e coverage. The fix adds an explicit E2E_TEST_MODE opt-in.
// These tests pin BOTH directions: the hatch stays refuse-by-default in real
// production, and the escape only opens for the explicit marker.
describe('env-schema — SSRF hatch refused in production', () => {
  test('production + hatch, no test marker → throws', () => {
    setRequired() // NODE_ENV=production
    deleteOptionalWarnVars()
    env.LLM_ALLOW_BLOCKED_HOSTS = 'true'
    delete env.E2E_TEST_MODE
    expect(() => validateEnv()).toThrow(/LLM_ALLOW_BLOCKED_HOSTS/)
  })

  test('production + hatch + E2E_TEST_MODE=true → allowed (prod-build e2e)', () => {
    setRequired()
    deleteOptionalWarnVars()
    env.LLM_ALLOW_BLOCKED_HOSTS = 'true'
    env.E2E_TEST_MODE = 'true'
    expect(() => validateEnv()).not.toThrow()
  })

  test('E2E_TEST_MODE alone does not enable the hatch', () => {
    // The marker only lifts the *validation* refusal; isBlockedHost() is what
    // actually reads LLM_ALLOW_BLOCKED_HOSTS. Neither one alone is a bypass.
    setRequired()
    deleteOptionalWarnVars()
    env.E2E_TEST_MODE = 'true'
    delete env.LLM_ALLOW_BLOCKED_HOSTS
    expect(() => validateEnv()).not.toThrow()
  })

  test('dev (non-production) + hatch still allowed without the marker', () => {
    setRequired()
    env.NODE_ENV = 'development'
    deleteOptionalWarnVars()
    env.LLM_ALLOW_BLOCKED_HOSTS = 'true'
    delete env.E2E_TEST_MODE
    expect(() => validateEnv()).not.toThrow()
  })

  test('hatch=false is always allowed', () => {
    setRequired()
    deleteOptionalWarnVars()
    env.LLM_ALLOW_BLOCKED_HOSTS = 'false'
    delete env.E2E_TEST_MODE
    expect(() => validateEnv()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// shouldRefuseBootForTestMode — the real boot predicate
// ---------------------------------------------------------------------------
// instrumentation.ts calls this exact function, so these tests exercise the
// production code path rather than a re-derivation of it. The guard protects
// the SSRF escape hatch (LLM_ALLOW_BLOCKED_HOSTS) from reaching a deployment.
describe('shouldRefuseBootForTestMode', () => {
  const base = { NODE_ENV: 'production', E2E_TEST_MODE: 'true' }

  test('refuses the prod-build e2e case only when a deployment marker exists', () => {
    // Playwright webServer: production build, no deploy marker → must be allowed,
    // otherwise the shipped artifact can never be tested end-to-end.
    expect(shouldRefuseBootForTestMode({ ...base })).toBe(false)
    expect(shouldRefuseBootForTestMode({ ...base, RYASAI_DEPLOYED: '1' })).toBe(true)
    expect(shouldRefuseBootForTestMode({ ...base, KUBERNETES_SERVICE_HOST: '10.0.0.1' })).toBe(true)
    // Docker sets HOSTNAME to the 12-hex-char container id.
    expect(shouldRefuseBootForTestMode({ ...base, HOSTNAME: 'a1b2c3d4e5f6' })).toBe(true)
  })

  test('does not refuse when the marker is absent or false', () => {
    expect(shouldRefuseBootForTestMode({ NODE_ENV: 'production' })).toBe(false)
    expect(shouldRefuseBootForTestMode({ NODE_ENV: 'production', E2E_TEST_MODE: 'false', RYASAI_DEPLOYED: '1' })).toBe(false)
  })

  test('does not refuse outside production', () => {
    expect(shouldRefuseBootForTestMode({ NODE_ENV: 'development', E2E_TEST_MODE: 'true', RYASAI_DEPLOYED: '1' })).toBe(false)
    expect(shouldRefuseBootForTestMode({ NODE_ENV: 'test', E2E_TEST_MODE: 'true', RYASAI_DEPLOYED: '1' })).toBe(false)
  })

  test('explicit operator override wins (escape hatch for exotic CI)', () => {
    expect(
      shouldRefuseBootForTestMode({
        ...base,
        RYASAI_DEPLOYED: '1',
        RYASAI_ALLOW_E2E_TEST_MODE: 'true',
      }),
    ).toBe(false)
  })

  test('a non-container hostname does not trigger the guard', () => {
    expect(shouldRefuseBootForTestMode({ ...base, HOSTNAME: 'localhost' })).toBe(false)
    expect(shouldRefuseBootForTestMode({ ...base, HOSTNAME: 'runner' })).toBe(false)
    // 12 hex chars is the docker id shape; 11 should not match.
    expect(shouldRefuseBootForTestMode({ ...base, HOSTNAME: 'a1b2c3d4e5f' })).toBe(false)
  })
})
