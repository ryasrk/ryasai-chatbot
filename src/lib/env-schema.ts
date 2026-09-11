/**
 * Env schema validation — fail-closed at app startup.
 * ----------------------------------------------------------------------------
 * Called from instrumentation.ts on server boot in TWO tiers:
 *
 *   FATAL (throws → instrumentation exits the process):
 *     - DATABASE_URL + ENCRYPTION_SECRET_KEY are checked in EVERY runtime
 *       except pure unit tests (`NODE_ENV=test`) — no DB URL or no encryption
 *       key means every request would fail; booting is strictly worse than
 *       refusing to start.
 *     - In production, the full zod schema is enforced on top.
 *
 *   WARNINGS (one consolidated loud block, then boot continues):
 *     - Optional vars whose absence degrades specific features at runtime
 *       (Redis queueing, Midtrans checkout, license issuance/verification).
 *       Built by collectOptionalEnvWarnings() — pure + unit-tested.
 *
 * ponytail: validateEnv() used to swallow ALL errors in instrumentation
 * (log-and-continue), which let a production box boot with no DATABASE_URL and
 * die per-request instead of at boot. The throw here is now load-bearing:
 * instrumentation.ts catches it and process.exit(1)s AFTER logging.
 */
import { z } from 'zod'

const EnvSchema = z.object({
  ENCRYPTION_SECRET_KEY: z
    .string()
    .min(8, 'ENCRYPTION_SECRET_KEY must be at least 8 chars. Generate with: openssl rand -hex 32')
    .refine(
      (v) => /^[0-9a-fA-F]{64}$/.test(v) || v.length >= 8,
      'Use a 64-char hex string for best security: openssl rand -hex 32',
    ),

  NODE_ENV: z.enum(['development', 'test', 'production', 'test-e2e']).optional(),

  // ponytail: REQUIRED — was once declared optional and a prod container booted
  // without it, failing every request instead of refusing to start.
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required — a postgresql:// URL to a Postgres 16+ server with pgvector.'),

  AUTH_DEMO_FALLBACK: z.enum(['true', 'false']).optional(),

  // ponytail: optional vars — only validate IF set
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  WS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  COGNEE_ENABLED: z.enum(['true', 'false']).optional(),
  COGNEE_DB_PROVIDER: z.enum(['local', 'postgres']).optional(),
  COGNEE_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).optional(),
  COGNEE_MAX_RETRIES: z.coerce.number().int().min(0).max(10).optional(),
  CONTEXTUAL_RETRIEVAL: z.enum(['true', 'false']).optional(),
  RAG_LLM_RERANK: z.enum(['true', 'false']).optional(),
  REDIS_URL: z.string().url().optional(),

  // --- Agentic / RAG tuning (optional, sensible defaults in code) ---
  AGENTIC_TOKEN_BUDGET: z.coerce.number().int().min(1).optional(),
  ALIGNMENT_CHECK: z.enum(['http', 'llm', 'disabled']).optional(),
  ALIGNMENT_CHECK_URL: z.string().url().optional(),
  HYDE: z.enum(['true', 'false']).optional(),
  REFLEXION_ENABLED: z.enum(['true', 'false']).optional(),
  RERANKER_URL: z.string().url().optional(),
  PARENT_DOC_CHILD_SIZE: z.coerce.number().int().min(1).optional(),
  PARENT_DOC_WINDOW: z.coerce.number().int().min(0).optional(),
  TOOL_TIMEOUT_MS: z.coerce.number().int().min(1).optional(),
  TOOL_TIMEOUT_SQL_MS: z.coerce.number().int().min(1).optional(),
  TOOL_TIMEOUT_PLUGIN_WEB_SEARCH_MS: z.coerce.number().int().min(1).optional(),

  // --- Security ---
  INCOMING_WEBHOOK_SECRET: z.string().min(1).optional(),

  // --- Billing (QRIS via Midtrans) — optional; purchase flow fails closed
  // without them (see collectOptionalEnvWarnings). Validated only if set.
  MIDTRANS_SERVER_KEY: z.string().min(1).optional(),
  MIDTRANS_CLIENT_KEY: z.string().min(1).optional(),
  MIDTRANS_IS_PRODUCTION: z.enum(['true', 'false']).optional(),
  NEXT_PUBLIC_MIDTRANS_CLIENT_KEY: z.string().min(1).optional(),
  NEXT_PUBLIC_MIDTRANS_IS_PRODUCTION: z.enum(['true', 'false']).optional(),

  // --- License validation / issuance — optional; each absence degrades a
  // specific licensing path (fail-closed at call time, see warnings below).
  LICENSE_INTERNAL_SECRET: z.string().min(1).optional(),
  LICENSE_SIGNING_PUBLIC_KEY: z.string().min(1).optional(),
  LICENSE_VALIDATOR_URL: z.string().url().optional(),

  // --- SSO / OIDC ---
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),

  // --- Observability ---
  OTEL_ENABLED: z.enum(['true', 'false']).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  LANGFUSE_BASEURL: z.string().url().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  HELICONE_API_KEY: z.string().optional(),

  // --- Email (Resend) — optional; scheduler falls back to webhook/telegram ---
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().optional(),

  // --- Server / scheduler ---
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1).optional(),
  SCHEDULER_POLL_INTERVAL_SEC: z.coerce.number().int().min(1).optional(),
  DEFAULT_API_RATE_PER_MINUTE: z.coerce.number().int().min(0).optional(),
  DEFAULT_API_DAILY_LIMIT: z.coerce.number().int().min(0).optional(),
  DB_SSL_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).optional(),

  // ponytail: SSRF escape hatch for tests. Refused outright in production —
  // combined with NODE_ENV=production this is always a misconfiguration.
  //
  // Exception: a production BUILD under e2e test. `next build` + the standalone
  // server run with NODE_ENV=production but must reach the localhost mock LLM,
  // so `E2E_TEST_MODE=true` unlocks it. That marker is a separate explicit
  // opt-in (never inferred from NODE_ENV) and is refused in production by
  // `assertNotTestModeInProduction` below — see also the boot guard in
  // instrumentation.ts. Without this, the prod-build e2e suite dies here at boot
  // and the shipped artifact has no end-to-end coverage at all.
  LLM_ALLOW_BLOCKED_HOSTS: z
    .enum(['true', 'false'])
    .optional()
    .refine(
      (v) =>
        v !== 'true' ||
        process.env.NODE_ENV !== 'production' ||
        process.env.E2E_TEST_MODE === 'true',
      { message: 'LLM_ALLOW_BLOCKED_HOSTS=true is not allowed in production.' },
    ),
  // Test-mode marker for prod-build e2e. Never set by install.sh, Dockerfile,
  // docker-compose.yml, or helm (see invariants: production manifests must not
  // set E2E_TEST_MODE).
  E2E_TEST_MODE: z.enum(['true', 'false']).optional(),
})

export type EnvSchema = z.infer<typeof EnvSchema>

/**
 * Should boot be refused because the E2E test marker leaked into a deployment?
 *
 * `E2E_TEST_MODE=true` disables the SSRF guard (`isBlockedHost` returns false),
 * so a tenant-configured LLM endpoint or REST connector could reach cloud
 * metadata IPs and internal ranges. It exists solely so the prod-build e2e
 * suite (NODE_ENV=production + the standalone server, which must reach the
 * localhost mock LLM) can run at all — see `playwright.prod.config.ts`.
 *
 * Pure and exported on purpose: the guard is security-critical, and a test that
 * re-derives the predicate can drift from the real one. `instrumentation.ts`
 * calls THIS function, and `env-schema.test.ts` exercises it directly.
 *
 * Deliberately conservative: a false positive only breaks an unusual test
 * environment (fixable with RYASAI_ALLOW_E2E_TEST_MODE=true), while a false
 * negative ships an SSRF bypass.
 */
export function shouldRefuseBootForTestMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.E2E_TEST_MODE !== 'true') return false
  // Explicit operator override — an escape for exotic CI, never for production.
  if (env.RYASAI_ALLOW_E2E_TEST_MODE === 'true') return false
  if (env.NODE_ENV !== 'production') return false
  // Deployment markers: an explicit flag, a Kubernetes pod, or a container
  // hostname (Docker sets HOSTNAME to the 12-hex-char container id).
  return Boolean(
    env.RYASAI_DEPLOYED ??
      env.KUBERNETES_SERVICE_HOST ??
      env.HOSTNAME?.match(/^[0-9a-f]{12,}$/),
  )
}

/**
 * Pure warning builder — what breaks at runtime when an OPTIONAL var is unset.
 * Exported + unit-tested so the boot block stays honest about degradation.
 * Never returns entries for vars that are set.
 */
export function collectOptionalEnvWarnings(
  env: Record<string, string | undefined>,
): string[] {
  const w: string[] = []
  if (!env.REDIS_URL) {
    w.push('REDIS_URL unset — background jobs (document embedding, cognify, FTS rebuild) run synchronously in-request; schedules and rate limiting fall back to in-memory/DB.')
  }
  if (!env.MIDTRANS_SERVER_KEY) {
    w.push('MIDTRANS_SERVER_KEY unset — QRIS license purchase API will reject requests (billing fails closed).')
  }
  if (!env.NEXT_PUBLIC_MIDTRANS_CLIENT_KEY) {
    w.push('NEXT_PUBLIC_MIDTRANS_CLIENT_KEY unset — Midtrans Snap checkout cannot load in the browser; users cannot buy licenses from the UI.')
  }
  if (!env.LICENSE_INTERNAL_SECRET) {
    w.push('LICENSE_INTERNAL_SECRET unset — paid webhooks cannot issue licenses (issuance fails closed).')
  }
  if (!env.LICENSE_SIGNING_PUBLIC_KEY) {
    w.push('LICENSE_SIGNING_PUBLIC_KEY unset — license responses cannot be signature-verified; licensing fails closed.')
  }
  return w
}

/** Render warnings as ONE consolidated boot block (single loud console entry). */
export function formatEnvWarningBlock(warnings: string[]): string {
  const lines = [
    '════════════════════════════════════════════════════════════════════',
    '⚠️  ENVIRONMENT WARNINGS — the app will start, but these features degrade:',
    '════════════════════════════════════════════════════════════════════',
    ...warnings.map((x) => `  • ${x}`),
    '════════════════════════════════════════════════════════════════════',
  ]
  return lines.join('\n')
}

let _validated = false
let _warnings: string[] = []

/** Validate process.env at startup. Throws on fatal errors, collects warnings. */
export function validateEnv(): { warnings: string[] } {
  if (_validated) return { warnings: _warnings }
  _validated = true
  _warnings = []

  // ponytail: pure unit tests (`bun test` sets NODE_ENV=test) run without a DB
  // on purpose — scripts/test.ts injects only ENCRYPTION_SECRET_KEY. Everything
  // else (dev server, e2e dev server, production) must have both required vars.
  if (process.env.NODE_ENV === 'test') return { warnings: _warnings }

  // --- Tier 1: ALWAYS-fatal vars (any non-test runtime) ---
  const missing: string[] = []
  if (!process.env.DATABASE_URL) {
    missing.push(
      'DATABASE_URL is not set — a postgresql:// URL to a Postgres 16+ server with pgvector is required. Copy .env.example to .env and configure it.',
    )
  }
  if (!process.env.ENCRYPTION_SECRET_KEY) {
    missing.push(
      'ENCRYPTION_SECRET_KEY is not set — generate one with: openssl rand -hex 32',
    )
  }
  if (missing.length > 0) {
    throw new Error(
      `[env-schema] Missing required environment variables — REFUSING TO BOOT:\n${missing
        .map((m) => `  ✗ ${m}`)
        .join('\n')}`,
    )
  }

  // ponytail: only validate the full schema in production or when explicitly enabled.
  // In dev, optional-var misuse is tolerated (config.ts still fail-closes per call).
  const isProd = process.env.NODE_ENV === 'production'

  // Warnings for suspicious values (both prod and dev — they are advisory).
  const key = process.env.ENCRYPTION_SECRET_KEY
  if (key && key.length < 32) {
    _warnings.push('ENCRYPTION_SECRET_KEY is shorter than 32 chars — consider using a 64-char hex string.')
  }
  if (key && /^(test|example|placeholder|changeme|secret)/i.test(key)) {
    _warnings.push('ENCRYPTION_SECRET_KEY looks like a placeholder — set a real secret in production.')
  }
  _warnings.push(...collectOptionalEnvWarnings(process.env))

  if (isProd) {
    if (process.env.AUTH_DEMO_FALLBACK === 'true') {
      _warnings.push('AUTH_DEMO_FALLBACK=true in PRODUCTION — demo auth fallback is enabled. Disable immediately.')
    }

    const result = EnvSchema.safeParse(process.env)
    if (!result.success) {
      const errors = result.error.issues
        .map((i) => `  ${i.path.join('.')}: ${i.message}`)
        .join('\n')
      throw new Error(`[env-schema] Invalid environment configuration:\n${errors}`)
    }
  }

  if (_warnings.length > 0) {
    console.warn(formatEnvWarningBlock(_warnings))
  }
  return { warnings: _warnings }
}

/** Reset validation state — for tests. */
export function resetEnvValidation(): void {
  _validated = false
  _warnings = []
}
