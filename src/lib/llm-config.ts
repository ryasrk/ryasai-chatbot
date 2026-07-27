import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'

export interface LlmRuntimeConfig {
  id: string
  provider: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface PublicLlmConfig {
  configured: boolean
  provider: string
  baseUrl: string
  model: string
  apiKeyMasked: string | null
  availableModels: string[]
  lastModelSyncAt: string | null
  embeddingProvider: string
  embeddingBaseUrl: string
  embeddingModel: string
  embeddingApiKeyMasked: string | null
  embeddingAvailableModels: string[]
  lastEmbeddingModelSyncAt: string | null
  updatedAt: string | null
}

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const url = new URL(trimmed)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must use http or https.')
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error('Base URL points to a blocked internal host.')
  }
  return url.toString().replace(/\/+$/, '')
}

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost') return true
  if (h === '::1' || h === '::') return true
  if (/^127\./.test(h)) return true
  if (/^0\.0\.0\.0$/.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(h)) return true
  if (/^fd[0-9a-f]/.test(h)) return true
  if (/^fe[89ab][0-9a-f]/.test(h)) return true
  return false
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••'
  return `${secret.slice(0, 4)}••••••${secret.slice(-4)}`
}

function parseModels(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function decryptApiKey(encryptedApiKey: string): string {
  const config = decryptConfig(encryptedApiKey)
  const apiKey = config.apiKey
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('Invalid LLM API key.')
  }
  return apiKey
}

export async function getLlmRuntimeConfig(): Promise<LlmRuntimeConfig | null> {
  const row = await db.llmConfig.findFirst({
    where: { purpose: 'chat' },
  }) ?? await db.llmConfig.findFirst()
  if (!row) return null
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    apiKey: decryptApiKey(row.encryptedApiKey),
    model: row.model,
  }
}

export async function getAgentLlmConfig(): Promise<LlmRuntimeConfig | null> {
  const row = await db.llmConfig.findFirst({
    where: { purpose: 'agent' },
  })
  if (!row) {
    // Fallback to chat config if agent config not set
    return getLlmRuntimeConfig()
  }
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    apiKey: decryptApiKey(row.encryptedApiKey),
    model: row.model,
  }
}

// ---------------------------------------------------------------------------
// Role-specific LLM config — LightRAG pattern.
// 4 roles: EXTRACT (entity-relation extraction), QUERY (answer synthesis),
// KEYWORD (keyword generation), VLM (multimodal).
// Each role can have its own model (fast/cheap for extraction, strong for answers).
// Falls back to chat config when no role-specific row exists.
// ponytail: uses the existing `purpose` field on LlmConfig — no schema change needed.
// Configure via LlmConfig rows with purpose = 'extract' | 'query' | 'keyword' | 'vlm'.
// ---------------------------------------------------------------------------

export type LlmRole = 'extract' | 'query' | 'keyword' | 'vlm' | 'chat' | 'agent'

const _roleCache = new Map<LlmRole, { config: LlmRuntimeConfig | null; ts: number }>()
const ROLE_CACHE_TTL = 30_000 // 30s — config rarely changes mid-session

export async function getRoleLlmConfig(role: LlmRole): Promise<LlmRuntimeConfig | null> {
  // Fast path: chat and agent use existing resolvers
  if (role === 'chat') return getLlmRuntimeConfig()
  if (role === 'agent') return getAgentLlmConfig()

  // Check cache
  const cached = _roleCache.get(role)
  if (cached && Date.now() - cached.ts < ROLE_CACHE_TTL) return cached.config

  // Look for a role-specific config row
  const row = await db.llmConfig.findFirst({ where: { purpose: role } })
  if (!row) {
    // Fall back to chat config — role-specific is opt-in
    const fallback = await getLlmRuntimeConfig()
    _roleCache.set(role, { config: fallback, ts: Date.now() })
    return fallback
  }

  const config: LlmRuntimeConfig = {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    apiKey: decryptApiKey(row.encryptedApiKey),
    model: row.model,
  }
  _roleCache.set(role, { config, ts: Date.now() })
  return config
}

export function invalidateRoleConfigCache(): void {
  _roleCache.clear()
}

export async function getPublicLlmConfig(): Promise<PublicLlmConfig> {
  const row = await db.llmConfig.findFirst()
  if (!row) {
    return {
      configured: false,
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: '',
      model: '',
      apiKeyMasked: null,
      availableModels: [],
      lastModelSyncAt: null,
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: '',
      embeddingModel: '',
      embeddingApiKeyMasked: null,
      embeddingAvailableModels: [],
      lastEmbeddingModelSyncAt: null,
      updatedAt: null,
    }
  }

  let apiKeyMasked: string | null = null
  try {
    apiKeyMasked = maskSecret(decryptApiKey(row.encryptedApiKey))
  } catch (e) {
    console.warn('[llm-config] decryptApiKey failed:', e)
    apiKeyMasked = '••••'
  }

  let embeddingApiKeyMasked: string | null = null
  if (row.encryptedEmbeddingApiKey) {
    try {
      embeddingApiKeyMasked = maskSecret(decryptApiKey(row.encryptedEmbeddingApiKey))
    } catch (e) {
      console.warn('[llm-config] decryptEmbeddingApiKey failed:', e)
      embeddingApiKeyMasked = '••••'
    }
  }

  return {
    configured: true,
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeyMasked,
    availableModels: parseModels(row.availableModels),
    lastModelSyncAt: row.lastModelSyncAt?.toISOString() ?? null,
    embeddingProvider: row.embeddingProvider ?? 'OPENAI_COMPATIBLE',
    embeddingBaseUrl: row.embeddingBaseUrl ?? row.baseUrl,
    embeddingModel: row.embeddingModel ?? 'text-embedding-3-small',
    embeddingApiKeyMasked,
    embeddingAvailableModels: parseModels(row.embeddingAvailableModels),
    lastEmbeddingModelSyncAt: row.lastEmbeddingModelSyncAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function fetchProviderModels(args: {
  baseUrl: string
  apiKey: string
}): Promise<string[]> {
  const baseUrl = normalizeBaseUrl(args.baseUrl)
  const apiKey = args.apiKey.trim()
  if (!apiKey) throw new Error('API key is required to fetch the model list.')

  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    throw new Error(`Failed to fetch models (HTTP ${res.status}).`)
  }

  const payload = (await res.json()) as {
    data?: Array<{ id?: unknown; name?: unknown }>
    models?: unknown[]
  }

  const fromData = Array.isArray(payload.data)
    ? payload.data.map((m) => m.id ?? m.name).map(String)
    : []
  const fromModels = Array.isArray(payload.models)
    ? payload.models.map((m) => {
        if (typeof m === 'string') return m
        if (m && typeof m === 'object' && 'id' in m) return String((m as { id: unknown }).id)
        if (m && typeof m === 'object' && 'name' in m) return String((m as { name: unknown }).name)
        return ''
      })
    : []

  return Array.from(new Set([...fromData, ...fromModels].filter(Boolean))).sort()
}
