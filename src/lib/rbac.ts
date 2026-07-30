export type Role = 'admin' | 'analyst' | 'viewer'

export type Resource =
  | 'dashboard' | 'history' | 'query' | 'document' | 'integration'
  | 'user' | 'llm_config' | 'plugin' | 'mcp' | 'schedule'
  | 'notification' | 'api_key' | 'audit' | 'prompt' | 'webhook'

export type Action = 'read' | 'create' | 'update' | 'delete' | 'execute'

const MATRIX: Partial<Record<Role, Partial<Record<Resource, Action[]>>>> = {
  admin: {}, // admin = everything (empty = all allowed)
  analyst: {
    dashboard: ['read'],
    history: ['read'],
    query: ['read', 'execute'],
    document: ['read', 'create', 'update', 'delete'],
    integration: ['read', 'execute'],
    prompt: ['read', 'create', 'update', 'delete'],
    audit: ['read'],
  },
  viewer: {
    dashboard: ['read'],
    history: ['read'],
    document: ['read'],
    integration: ['read'],
    prompt: ['read'],
  },
}

export function checkPermission(role: Role, resource: Resource, action: Action): boolean {
  if (role === 'admin') return true
  const allowed = MATRIX[role]?.[resource]
  return allowed ? allowed.includes(action) : false
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN'
  constructor(message = 'Insufficient permissions.') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export function requirePermission(role: Role, resource: Resource, action: Action): void {
  if (!checkPermission(role, resource, action)) {
    throw new ForbiddenError(`Role "${role}" cannot ${action} on "${resource}".`)
  }
}

// ponytail: fail-closed — unknown/null role gets least privilege (viewer).
export function normalizeRole(v: string | null | undefined): Role {
  if (v === 'admin' || v === 'analyst' || v === 'viewer') return v
  return 'viewer'
}
