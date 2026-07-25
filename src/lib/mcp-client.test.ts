import { test, expect, describe, beforeEach } from 'bun:test'
import {
  callMcpTool,
  testMcpServer,
  disconnectMcpServer,
  disconnectAllMcp,
  invalidateMcpToolsCache,
  listMcpTools,
} from '@/lib/mcp-client'

describe('mcp-client — safe paths with no live servers', () => {
  beforeEach(() => {
    invalidateMcpToolsCache()
  })

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
