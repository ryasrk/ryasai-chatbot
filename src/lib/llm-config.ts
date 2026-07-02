import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'

export interface LlmRuntimeConfig {
  id: string
  companyId: string
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
    throw new Error('Base URL harus menggunakan http atau https.')
  }
  if (isBlockedHost(url.hostname)) {
    // SSRF guard: block cloud-metadata / link-local targets. Localhost and
    // private ranges stay allowed (legit for local LLMs like Ollama / internal gateways).
    throw new Error('Base URL menuju host internal yang diblokir.')
  }
  return url.toString().replace(/\/+$/, '')
}

/** Block link-local (169.254.0.0/16 — AWS/GCP/Azure metadata) + 0.0.0.0. */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (/^169\.254\./.test(h)) return true
  if (/^0\.0\.0\.0$/.test(h)) return true
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
    throw new Error('API key LLM tidak valid.')
  }
  return apiKey
}

export async function getLlmRuntimeConfig(companyId?: string): Promise<LlmRuntimeConfig | null> {
  if (!companyId) return null
  const row = await db.llmConfig.findUnique({ where: { companyId } })
  if (!row) return null
  return {
    id: row.id,
    companyId: row.companyId,
    provider: row.provider,
    baseUrl: row.baseUrl,
    apiKey: decryptApiKey(row.encryptedApiKey),
    model: row.model,
  }
}

export async function getPublicLlmConfig(companyId: string): Promise<PublicLlmConfig> {
  const row = await db.llmConfig.findUnique({ where: { companyId } })
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
  } catch {
    apiKeyMasked = '••••'
  }

  let embeddingApiKeyMasked: string | null = null
  if (row.encryptedEmbeddingApiKey) {
    try {
      embeddingApiKeyMasked = maskSecret(decryptApiKey(row.encryptedEmbeddingApiKey))
    } catch {
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
    embeddingModel: row.embeddingModel ?? '',
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
  if (!apiKey) throw new Error('API key wajib diisi untuk mengambil daftar model.')

  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    // Don't reflect the upstream body — it can leak internal service details (SSRF).
    throw new Error(`Gagal mengambil model (HTTP ${res.status}).`)
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
