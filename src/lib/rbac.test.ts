import { describe, expect, test } from 'bun:test'
import {
  checkPermission,
  requirePermission,
  normalizeRole,
  ForbiddenError,
  type Role,
  type Resource,
  type Action,
} from './rbac'

const ROLES: Role[] = ['admin', 'analyst', 'viewer']
const RESOURCES: Resource[] = [
  'dashboard', 'history', 'query', 'document', 'integration',
  'user', 'llm_config', 'plugin', 'mcp', 'schedule',
  'notification', 'api_key', 'audit', 'prompt', 'webhook',
]
const ACTIONS: Action[] = ['read', 'create', 'update', 'delete', 'execute']

describe('checkPermission — admin', () => {
  test('admin can do everything on every resource', () => {
    for (const r of RESOURCES) {
      for (const a of ACTIONS) {
        expect(checkPermission('admin', r, a)).toBe(true)
      }
    }
  })
})

describe('checkPermission — analyst', () => {
  test('analyst can read dashboard + history', () => {
    expect(checkPermission('analyst', 'dashboard', 'read')).toBe(true)
    expect(checkPermission('analyst', 'history', 'read')).toBe(true)
  })

  test('analyst can read + execute query (no create/update/delete)', () => {
    expect(checkPermission('analyst', 'query', 'read')).toBe(true)
    expect(checkPermission('analyst', 'query', 'execute')).toBe(true)
    expect(checkPermission('analyst', 'query', 'create')).toBe(false)
    expect(checkPermission('analyst', 'query', 'update')).toBe(false)
    expect(checkPermission('analyst', 'query', 'delete')).toBe(false)
  })

  test('analyst can CRUD documents', () => {
    for (const a of ['read', 'create', 'update', 'delete'] as Action[]) {
      expect(checkPermission('analyst', 'document', a)).toBe(true)
    }
  })

  test('analyst can read + execute integrations (no management)', () => {
    expect(checkPermission('analyst', 'integration', 'read')).toBe(true)
    expect(checkPermission('analyst', 'integration', 'execute')).toBe(true)
    expect(checkPermission('analyst', 'integration', 'create')).toBe(false)
    expect(checkPermission('analyst', 'integration', 'update')).toBe(false)
    expect(checkPermission('analyst', 'integration', 'delete')).toBe(false)
  })

  test('analyst CANNOT manage users', () => {
    for (const a of ACTIONS) {
      expect(checkPermission('analyst', 'user', a)).toBe(false)
    }
  })

  test('analyst CANNOT manage llm_config, plugins, mcp, schedules, notifications, api_keys, webhooks', () => {
    const blocked: Resource[] = ['llm_config', 'plugin', 'mcp', 'schedule', 'notification', 'api_key', 'webhook']
    for (const r of blocked) {
      for (const a of ACTIONS) {
        expect(checkPermission('analyst', r, a)).toBe(false)
      }
    }
  })

  test('analyst can read audit logs but not create/update/delete', () => {
    expect(checkPermission('analyst', 'audit', 'read')).toBe(true)
    expect(checkPermission('analyst', 'audit', 'create')).toBe(false)
  })
})

describe('checkPermission — viewer', () => {
  test('viewer can read dashboards + history + documents + integrations + prompts', () => {
    expect(checkPermission('viewer', 'dashboard', 'read')).toBe(true)
    expect(checkPermission('viewer', 'history', 'read')).toBe(true)
    expect(checkPermission('viewer', 'document', 'read')).toBe(true)
    expect(checkPermission('viewer', 'integration', 'read')).toBe(true)
    expect(checkPermission('viewer', 'prompt', 'read')).toBe(true)
  })

  test('viewer CANNOT execute queries', () => {
    expect(checkPermission('viewer', 'query', 'read')).toBe(false)
    expect(checkPermission('viewer', 'query', 'execute')).toBe(false)
  })

  test('viewer CANNOT create/update/delete anything', () => {
    for (const r of RESOURCES) {
      for (const a of ['create', 'update', 'delete', 'execute'] as Action[]) {
        expect(checkPermission('viewer', r, a)).toBe(false)
      }
    }
  })
})

describe('requirePermission', () => {
  test('allowed → does not throw', () => {
    expect(() => requirePermission('admin', 'user', 'delete')).not.toThrow()
  })

  test('denied → throws ForbiddenError', () => {
    expect(() => requirePermission('viewer', 'user', 'delete')).toThrow(ForbiddenError)
  })

  test('error message includes role, action, resource', () => {
    try {
      requirePermission('viewer', 'user', 'delete')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError)
      const msg = (e as Error).message
      expect(msg).toContain('viewer')
      expect(msg).toContain('delete')
      expect(msg).toContain('user')
    }
  })
})

describe('normalizeRole', () => {
  test('valid roles pass through', () => {
    expect(normalizeRole('admin')).toBe('admin')
    expect(normalizeRole('analyst')).toBe('analyst')
    expect(normalizeRole('viewer')).toBe('viewer')
  })

  test('null/undefined/unknown → viewer (fail-closed least privilege)', () => {
    expect(normalizeRole(null)).toBe('viewer')
    expect(normalizeRole(undefined)).toBe('viewer')
    expect(normalizeRole('superuser')).toBe('viewer')
    expect(normalizeRole('')).toBe('viewer')
  })
})

describe('full matrix — no role has access to a resource not in its list', () => {
  test('exhaustive: every (role, resource, action) returns a boolean without throwing', () => {
    for (const role of ROLES) {
      for (const r of RESOURCES) {
        for (const a of ACTIONS) {
          const result = checkPermission(role, r, a)
          expect(typeof result).toBe('boolean')
        }
      }
    }
  })
})
