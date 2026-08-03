/**
 * Env schema validation — fail-closed at app startup.
 * ----------------------------------------------------------------------------
 * Called from instrumentation.ts on server boot. Throws on invalid/missing
 * required env vars so the app fails fast instead of silently misbehaving.
 *
 * ponytail: only validates vars that MUST exist for the app to function
 * correctly. Optional vars with sensible defaults are not validated here.
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

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required. Set to file:./prisma/dev.db for SQLite.').optional(),

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
})

export type EnvSchema = z.infer<typeof EnvSchema>

let _validated = false
let _warnings: string[] = []

/** Validate process.env at startup. Throws on hard errors, collects warnings. */
export function validateEnv(): { warnings: string[] } {
  if (_validated) return { warnings: _warnings }
  _validated = true
  _warnings = []

  // ponytail: only validate in production or when explicitly enabled.
  // In dev/test, missing ENCRYPTION_SECRET_KEY is fine (config.ts derives one).
  const isProd = process.env.NODE_ENV === 'production'
  if (!isProd) return { warnings: _warnings }

  const result = EnvSchema.safeParse(process.env)
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`[env-schema] Invalid environment configuration:\n${errors}`)
  }

  // Warnings for suspicious values
  const key = process.env.ENCRYPTION_SECRET_KEY
  if (key && key.length < 32) {
    _warnings.push('ENCRYPTION_SECRET_KEY is shorter than 32 chars — consider using a 64-char hex string.')
  }
  if (key && /^(test|example|placeholder|changeme|secret)/i.test(key)) {
    _warnings.push('ENCRYPTION_SECRET_KEY looks like a placeholder — set a real secret in production.')
  }
  if (process.env.AUTH_DEMO_FALLBACK === 'true' && isProd) {
    _warnings.push('AUTH_DEMO_FALLBACK=true in PRODUCTION — demo auth fallback is enabled. Disable immediately.')
  }

  for (const w of _warnings) console.warn('[env-schema]', w)
  return { warnings: _warnings }
}

/** Reset validation state — for tests. */
export function resetEnvValidation(): void {
  _validated = false
  _warnings = []
}
