import { test, expect, describe, mock, beforeEach } from 'bun:test'

const mockFindUnique = mock(async () => null as unknown)
const mockFindMany = mock(async () => [] as unknown[])

mock.module('@/lib/db', () => ({
  db: {
    mcpServer: {
      findUnique: mockFindUnique,
      findMany: mockFindMany,
    },
  },
}))

import {
  callMcpTool,
  testMcpServer,
  disconnectMcpServer,
  disconnectAllMcp,
  invalidateMcpToolsCache,
  listMcpTools,
} from '@/lib/mcp-client'

beforeEach(() => {
  invalidateMcpToolsCache()
  mockFindUnique.mockImplementation(async () => null)
  mockFindMany.mockImplementation(async () => [])
})

describe('mcp-client — safe paths with no live servers', () => {
  test('callMcpTool with unknown server → ok false', async () => {
    const r = await callMcpTool('nonexistent-cuid', 'some_tool', { q: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  test('testMcpServer with unknown server → ok false', async () => {
    const r = await testMcpServer('nonexistent-cuid')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  test('disconnectMcpServer with unknown id → resolves without throwing', async () => {
    await expect(disconnectMcpServer('nonexistent-cuid')).resolves.toBeUndefined()
  })

  test('disconnectAllMcp → resolves without throwing', async () => {
    await expect(disconnectAllMcp()).resolves.toBeUndefined()
  })

  test('invalidateMcpToolsCache + listMcpTools → returns an array', async () => {
    invalidateMcpToolsCache()
    const tools = await listMcpTools()
    expect(Array.isArray(tools)).toBe(true)
  })
})

describe('testMcpServer — server found in DB', () => {
  test('disabled server → ok false with "disabled" message', async () => {
    mockFindUnique.mockImplementationOnce(async () => ({
      id: 'srv-1',
      name: 'test-server',
      description: '',
      transport: 'stdio',
      command: 'echo',
      args: '[]',
      url: '',
      envJson: '{}',
      headersJson: '{}',
      isEnabled: false,
    }))

    const r = await testMcpServer('srv-1')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('disabled')
  })

  test('stdio transport with no command → ok false with "Invalid transport config"', async () => {
    mockFindUnique.mockImplementationOnce(async () => ({
      id: 'srv-2',
      name: 'no-cmd',
      description: '',
      transport: 'stdio',
      command: '',
      args: '[]',
      url: '',
      envJson: '{}',
      headersJson: '{}',
      isEnabled: true,
    }))

    const r = await testMcpServer('srv-2')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Invalid transport config')
  })

  test('sse transport with no URL → ok false with "Invalid transport config"', async () => {
    mockFindUnique.mockImplementationOnce(async () => ({
      id: 'srv-3',
      name: 'no-url',
      description: '',
      transport: 'sse',
      command: '',
      args: '[]',
      url: '',
      envJson: '{}',
      headersJson: '{}',
      isEnabled: true,
    }))

    const r = await testMcpServer('srv-3')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Invalid transport config')
  })

  test('sse transport with SSRF-blocked host (localhost) → ok false', async () => {
    mockFindUnique.mockImplementationOnce(async () => ({
      id: 'srv-4',
      name: 'ssrf',
      description: '',
      transport: 'sse',
      command: '',
      args: '[]',
      url: 'http://localhost:8080/sse',
      envJson: '{}',
      headersJson: '{}',
      isEnabled: true,
    }))

    const r = await testMcpServer('srv-4')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Invalid transport config')
  })

  test('sse transport with SSRF-blocked host (169.254.x) → ok false', async () => {
    mockFindUnique.mockImplementationOnce(async () => ({
      id: 'srv-5',
      name: 'metadata',
      description: '',
      transport: 'http',
      command: '',
      args: '[]',
      url: 'http://169.254.169.254/latest',
      envJson: '{}',
      headersJson: '{}',
      isEnabled: true,
    }))

    const r = await testMcpServer('srv-5')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Invalid transport config')
  })

  test('unsupported transport type → ok false with "Invalid transport config"', async () => {
    mockFindUnique.mockImplementationOnce(async () => ({
      id: 'srv-6',
      name: 'bad-transport',
      description: '',
      transport: 'grpc',
      command: '',
      args: '[]',
      url: 'http://example.com',
      envJson: '{}',
      headersJson: '{}',
      isEnabled: true,
    }))

    const r = await testMcpServer('srv-6')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Invalid transport config')
  })
})

describe('callMcpTool — server in DB but unreachable', () => {
  test('disabled server → ok false with "unavailable"', async () => {
    mockFindUnique.mockImplementationOnce(async () => ({
      id: 'call-1',
      name: 'disabled-srv',
      description: '',
      transport: 'stdio',
      command: 'echo',
      args: '[]',
      url: '',
      envJson: '{}',
      headersJson: '{}',
      isEnabled: false,
    }))

    const r = await callMcpTool('call-1', 'some_tool', { q: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  test('enabled server with invalid transport → ok false with "unavailable"', async () => {
    mockFindUnique.mockImplementationOnce(async () => ({
      id: 'call-2',
      name: 'bad-transport',
      description: '',
      transport: 'stdio',
      command: '',
      args: '[]',
      url: '',
      envJson: '{}',
      headersJson: '{}',
      isEnabled: true,
    }))

    const r = await callMcpTool('call-2', 'some_tool', { q: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('unavailable')
  })
})

describe('listMcpTools — with servers in DB', () => {
  test('server with invalid transport → skipped, returns empty array', async () => {
    mockFindMany.mockImplementationOnce(async () => [
      {
        id: 'list-1',
        name: 'bad-srv',
        description: '',
        transport: 'stdio',
        command: '',
        args: '[]',
        url: '',
        envJson: '{}',
        headersJson: '{}',
        isEnabled: true,
      },
    ])

    invalidateMcpToolsCache()
    const tools = await listMcpTools()
    expect(Array.isArray(tools)).toBe(true)
    expect(tools.length).toBe(0)
  })

  test('multiple servers with invalid transports → all skipped', async () => {
    mockFindMany.mockImplementationOnce(async () => [
      {
        id: 'list-2',
        name: 'srv-a',
        description: '',
        transport: 'stdio',
        command: '',
        args: '[]',
        url: '',
        envJson: '{}',
        headersJson: '{}',
        isEnabled: true,
      },
      {
        id: 'list-3',
        name: 'srv-b',
        description: '',
        transport: 'sse',
        command: '',
        args: '[]',
        url: '',
        envJson: '{}',
        headersJson: '{}',
        isEnabled: true,
      },
    ])

    invalidateMcpToolsCache()
    const tools = await listMcpTools()
    expect(tools.length).toBe(0)
  })

  test('cache: second call within TTL does not re-fetch from DB', async () => {
    mockFindMany.mockImplementationOnce(async () => [])
    invalidateMcpToolsCache()
    await listMcpTools()
    const callsAfterFirst = mockFindMany.mock.calls.length

    await listMcpTools()
    expect(mockFindMany.mock.calls.length).toBe(callsAfterFirst)
  })

  test('invalidateMcpToolsCache forces re-fetch on next listMcpTools', async () => {
    mockFindMany.mockImplementation(async () => [])
    invalidateMcpToolsCache()
    await listMcpTools()
    const callsAfterFirst = mockFindMany.mock.calls.length

    invalidateMcpToolsCache()
    await listMcpTools()
    expect(mockFindMany.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })
})
