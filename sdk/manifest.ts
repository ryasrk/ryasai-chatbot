import type { PluginManifest, PluginAuthType, PluginMethod } from './types'

const METHODS: readonly PluginMethod[] = ['GET', 'POST']
const AUTH_TYPES: readonly PluginAuthType[] = ['NONE', 'BEARER', 'API_KEY_HEADER']

/**
 * Build + validate a PluginManifest from a partial. Throws on invalid input.
 * Defaults: executorType='webhook', method='POST', authType='NONE',
 * timeoutMs=15000, paramDescription='', description=''.
 */
export function createManifest(
  partial: Partial<PluginManifest> & { endpoint: string },
): PluginManifest {
  if (!partial.endpoint || typeof partial.endpoint !== 'string') {
    throw new Error('createManifest: endpoint is required and must be a URL string.')
  }
  try {
    new URL(partial.endpoint)
  } catch {
    throw new Error(`createManifest: endpoint is not a valid URL: "${partial.endpoint}"`)
  }

  const method = (partial.method ?? 'POST').toUpperCase() as PluginMethod
  if (!METHODS.includes(method)) {
    throw new Error(`createManifest: method must be one of ${METHODS.join(', ')}, got "${method}".`)
  }

  const authType = partial.authType ?? 'NONE'
  if (!AUTH_TYPES.includes(authType)) {
    throw new Error(`createManifest: authType must be one of ${AUTH_TYPES.join(', ')}.`)
  }

  const timeoutMs = partial.timeoutMs ?? 15000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error('createManifest: timeoutMs must be an integer between 1000 and 120000.')
  }

  if (authType !== 'NONE' && !partial.authCredentials) {
    throw new Error(`createManifest: authCredentials is required when authType="${authType}".`)
  }

  return {
    paramDescription: partial.paramDescription ?? '',
    executorType: 'webhook',
    endpoint: partial.endpoint,
    method,
    authType,
    authCredentials: partial.authCredentials,
    timeoutMs,
    description: partial.description ?? '',
  }
}
