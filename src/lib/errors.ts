/**
 * Typed error system — consistent `{ error: { code, message, hint? } }`
 * API responses. AppError is the base for typed throw sites; the legacy
 * UnauthorizedError (session.ts) and LlmNotConfiguredError (moved here from
 * ai.ts) are recognised by toTypedError so existing throw sites get typed
 * codes without changes.
 */
import { UnauthorizedError } from '@/lib/session'

export type ErrorCode =
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_ERROR'
  | 'RATE_LIMITED' | 'LLM_NOT_CONFIGURED' | 'LLM_ERROR' | 'LLM_TIMEOUT'
  | 'GUARDRAIL_BLOCK' | 'SQL_ERROR' | 'REST_ERROR' | 'PLUGIN_ERROR'
  | 'MCP_ERROR' | 'CONFIG_ERROR' | 'SETUP_REQUIRED' | 'INTERNAL_ERROR'

export interface TypedErrorResponse {
  error: { code: ErrorCode; message: string; hint?: string }
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super(
      'LLM is not configured. Open Settings → AI Configuration and set the endpoint + API key before using Chat.',
    )
    this.name = 'LlmNotConfiguredError'
  }
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly hint?: string
  readonly statusCode: number
  constructor(
    code: ErrorCode,
    message: string,
    opts?: { hint?: string; statusCode?: number; cause?: unknown },
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.hint = opts?.hint
    this.statusCode = opts?.statusCode ?? defaultStatusForCode(code)
    if (opts?.cause) (this as any).cause = opts.cause
  }
}

function defaultStatusForCode(code: ErrorCode): number {
  switch (code) {
    case 'UNAUTHORIZED': return 401
    case 'FORBIDDEN': return 403
    case 'NOT_FOUND': return 404
    case 'VALIDATION_ERROR': return 400
    case 'RATE_LIMITED': return 429
    case 'LLM_NOT_CONFIGURED': return 503
    case 'LLM_ERROR': case 'LLM_TIMEOUT': return 502
    case 'GUARDRAIL_BLOCK': return 403
    case 'SQL_ERROR': case 'REST_ERROR': case 'PLUGIN_ERROR': case 'MCP_ERROR': return 502
    case 'CONFIG_ERROR': return 500
    case 'SETUP_REQUIRED': return 503
    default: return 500
  }
}

// ponytail: errors.ts ↔ session.ts is a safe ESM cycle — neither module uses
// the other's binding at eval time (only inside functions called later).
export function toTypedError(e: unknown): {
  code: ErrorCode
  message: string
  hint?: string
  statusCode: number
} {
  if (e instanceof AppError) return { code: e.code, message: e.message, hint: e.hint, statusCode: e.statusCode }
  if (e instanceof UnauthorizedError) return { code: 'UNAUTHORIZED', message: e.message, statusCode: 401 }
  if (e instanceof LlmNotConfiguredError) return { code: 'LLM_NOT_CONFIGURED', message: e.message, statusCode: 503 }
  const msg = e instanceof Error ? e.message : String(e)
  return { code: 'INTERNAL_ERROR', message: msg, statusCode: 500 }
}
