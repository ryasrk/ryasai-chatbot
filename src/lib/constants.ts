/**
 * Centralized constants — single source of truth for magic numbers.
 * Extracted from guardrails, rag, middleware, llm-client, notifications.
 */

// Guardrails
export const SQL_MAX_LIMIT = 100

// RAG
export const RAG_CHUNK_SIZE = 1400
export const RAG_CHUNK_OVERLAP = 180
export const RAG_MAX_PER_DOCUMENT = 2
export const RAG_CACHE_TTL_MS = 60_000
export const RAG_MAX_CHUNKS_PER_UPLOAD = 500

// Rate limiting
export const RATE_LIMIT_WINDOW_MS = 60_000
export const RATE_LIMIT_DEFAULT = 60
export const RATE_LIMIT_CHAT = 30
export const RATE_LIMIT_LOGIN = 10
export const RATE_LIMIT_AGENT = 20
export const RATE_LIMIT_UPLOAD = 20

// LLM
export const LLM_TIMEOUT_MS = 30_000
export const LLM_STREAM_TIMEOUT_MS = 120_000
export const LLM_MAX_RETRIES = 3
export const LLM_RETRY_BACKOFF_BASE_MS = 500

// Session
export const SESSION_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000

// Notifications
export const NOTIFICATION_MAX_RETRIES = 3
export const NOTIFICATION_BACKOFF_BASE_MS = 2000
export const NOTIFICATION_TIMEOUT_MS = 15_000
