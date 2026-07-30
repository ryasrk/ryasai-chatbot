import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { setupGracefulShutdown } from './graceful-shutdown'

const originalExit = process.exit
const originalEnv = { ...process.env }

beforeEach(() => {
  process.exit = mock((code?: number) => {
    throw new Error(`EXIT_${code ?? 0}`)
  }) as never
  delete process.env.SHUTDOWN_TIMEOUT_MS
})
afterEach(() => {
  process.exit = originalExit
  Object.assign(process.env, originalEnv)
})

describe('setupGracefulShutdown', () => {
  test('calls server.close before process.exit', async () => {
    const closeOrder: string[] = []
    const server = {
      close: () => {
        closeOrder.push('server.close')
      },
    }
    const handle = setupGracefulShutdown(server)

    await expect(handle.shutdown('SIGTERM')).rejects.toThrow('EXIT_0')
    expect(closeOrder).toEqual(['server.close'])
    handle.remove()
  })

  test('runs cleanup functions in order', async () => {
    const order: string[] = []
    const handle = setupGracefulShutdown(undefined, [
      () => {
        order.push('cleanup-1')
      },
      () => {
        order.push('cleanup-2')
      },
    ])

    await expect(handle.shutdown('SIGTERM')).rejects.toThrow('EXIT_0')
    expect(order).toEqual(['cleanup-1', 'cleanup-2'])
    handle.remove()
  })

  test('server.close runs before cleanup functions', async () => {
    const order: string[] = []
    const handle = setupGracefulShutdown(
      {
        close: () => {
          order.push('server')
        },
      },
      [
        () => {
          order.push('cleanup')
        },
      ],
    )

    await expect(handle.shutdown('SIGTERM')).rejects.toThrow('EXIT_0')
    expect(order).toEqual(['server', 'cleanup'])
    handle.remove()
  })

  test('idempotent — second shutdown call is a no-op', async () => {
    const closeMock = mock(() => {})
    const handle = setupGracefulShutdown({ close: closeMock })

    await expect(handle.shutdown('SIGTERM')).rejects.toThrow('EXIT_0')
    // Reset exit mock for second call
    process.exit = mock((code?: number) => {
      throw new Error(`EXIT_${code ?? 0}`)
    }) as never
    await handle.shutdown('SIGTERM')
    expect(closeMock.mock.calls.length).toBe(1)
    handle.remove()
  })

  test('cleanup errors do not prevent exit', async () => {
    const handle = setupGracefulShutdown(undefined, [
      () => {
        throw new Error('cleanup failed')
      },
    ])

    await expect(handle.shutdown('SIGINT')).rejects.toThrow('EXIT_0')
    handle.remove()
  })

  test('async cleanup functions are awaited', async () => {
    const order: string[] = []
    const handle = setupGracefulShutdown(undefined, [
      async () => {
        await new Promise((r) => setTimeout(r, 10))
        order.push('async-cleanup')
      },
    ])

    await expect(handle.shutdown('SIGTERM')).rejects.toThrow('EXIT_0')
    expect(order).toEqual(['async-cleanup'])
    handle.remove()
  })

  test('remove unregisters signal handlers', () => {
    const originalListeners = {
      SIGTERM: process.listeners('SIGTERM').length,
      SIGINT: process.listeners('SIGINT').length,
    }
    const handle = setupGracefulShutdown()
    expect(process.listeners('SIGTERM').length).toBe(originalListeners.SIGTERM + 1)
    expect(process.listeners('SIGINT').length).toBe(originalListeners.SIGINT + 1)
    handle.remove()
    expect(process.listeners('SIGTERM').length).toBe(originalListeners.SIGTERM)
    expect(process.listeners('SIGINT').length).toBe(originalListeners.SIGINT)
  })

  test('uses SHUTDOWN_TIMEOUT_MS env var when set', async () => {
    process.env.SHUTDOWN_TIMEOUT_MS = '5000'
    const handle = setupGracefulShutdown()
    // ponytail: can't easily test the timer value, but verify no crash
    await expect(handle.shutdown('SIGTERM')).rejects.toThrow('EXIT_0')
    handle.remove()
  })
})
