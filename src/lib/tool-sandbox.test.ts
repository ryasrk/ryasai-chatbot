import { describe, expect, test, afterEach } from 'bun:test'
import { withToolSandbox, ToolTimeoutError } from './tool-sandbox'

afterEach(() => {
  delete process.env.TOOL_TIMEOUT_MS
  delete process.env.TOOL_TIMEOUT_SQL_MS
  delete process.env.TOOL_TIMEOUT_PLUGIN_WEB_SEARCH_MS
})

describe('withToolSandbox', () => {
  test('returns result on normal execution', async () => {
    const result = await withToolSandbox('test', async () => 42)
    expect(result).toBe(42)
  })

  test('throws ToolTimeoutError on timeout', async () => {
    await expect(
      withToolSandbox('slow', async () => new Promise((resolve) => setTimeout(resolve, 500)), 50),
    ).rejects.toThrow(ToolTimeoutError)
  })

  test('timeout error has tool name and duration', async () => {
    try {
      await withToolSandbox('mytool', async () => new Promise((resolve) => setTimeout(resolve, 500)), 50)
      expect(false).toBe(true)
    } catch (e) {
      expect(e).toBeInstanceOf(ToolTimeoutError)
      const err = e as ToolTimeoutError
      expect(err.toolName).toBe('mytool')
      expect(err.durationMs).toBe(50)
    }
  })

  test('custom timeout allows completion', async () => {
    const result = await withToolSandbox('fast', async () => new Promise((resolve) => setTimeout(() => resolve('done'), 20)), 200)
    expect(result).toBe('done')
  })

  test('per-tool override via env', async () => {
    process.env.TOOL_TIMEOUT_SQL_MS = '50'
    await expect(
      withToolSandbox('sql', async () => new Promise((resolve) => setTimeout(resolve, 200))),
    ).rejects.toThrow(ToolTimeoutError)
  })

  test('per-tool override with special characters in name', async () => {
    process.env.TOOL_TIMEOUT_PLUGIN_WEB_SEARCH_MS = '50'
    await expect(
      withToolSandbox('plugin:web_search', async () => new Promise((resolve) => setTimeout(resolve, 200))),
    ).rejects.toThrow(ToolTimeoutError)
  })

  test('default timeout from env TOOL_TIMEOUT_MS', async () => {
    process.env.TOOL_TIMEOUT_MS = '50'
    await expect(
      withToolSandbox('anytool', async () => new Promise((resolve) => setTimeout(resolve, 200))),
    ).rejects.toThrow(ToolTimeoutError)
  })

  test('propagates function errors', async () => {
    await expect(
      withToolSandbox('errortool', async () => { throw new Error('boom') }, 1000),
    ).rejects.toThrow('boom')
  })
})
