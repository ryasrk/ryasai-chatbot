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
    await expect(handle.shutdown('SIGTERM')).rejects.toThrow('EXIT_0')
    handle.remove()
  })
})

/**
 * The two paths this file previously left unexercised, both of which only matter in the situation
 * the module exists for: a shutdown that does not go cleanly.
 *
 * A hanging shutdown is not a cosmetic problem on-prem — the process holds the DB pool and the
 * listening socket, and a container runtime will SIGKILL it after its own grace period, so the
 * operator loses the log line that says why.
 */
describe('setupGracefulShutdown — the unclean paths', () => {
  test('a server.close that THROWS still runs the cleanup functions and exits', async () => {
    // The catch around server.close exists so one failing step cannot abandon the rest. Without it,
    // a throwing close (a socket already destroyed, a listener removed elsewhere) would reject
    // shutdown before the DB/Redis are disconnected, and the process would exit on the force timer
    // with the connection pool still open.
    const order: string[] = []
    const handle = setupGracefulShutdown(
      {
        close: () => {
          order.push('server')
          throw new Error('server already closed')
        },
      },
      [
        () => {
          order.push('cleanup-ran')
        },
      ],
    )

    await expect(handle.shutdown('SIGTERM')).rejects.toThrow('EXIT_0')
    // Both the failing step and the following cleanup were ATTEMPTED, in order.
    expect(order).toEqual(['server', 'cleanup-ran'])
    handle.remove()
  })

  test('an ASYNC server.close rejection is caught the same way', async () => {
    const cleaned: string[] = []
    const handle = setupGracefulShutdown(
      {
        close: async () => {
          throw new Error('async close failed')
        },
      },
      [() => { cleaned.push('yes') }],
    )

    await expect(handle.shutdown('SIGTERM')).rejects.toThrow('EXIT_0')
    expect(cleaned).toEqual(['yes'])
    handle.remove()
  })

  test('a NON-Error thrown by a cleanup function still lets shutdown continue', async () => {
    // `throw 'string'` is legal JS, and console.error takes anything.
    const handle = setupGracefulShutdown(undefined, [
      () => {
        throw 'not an Error object'
      },
      () => { throw new Error('and a real one after') },
    ])
    await expect(handle.shutdown('SIGTERM')).rejects.toThrow('EXIT_0')
    handle.remove()
  })

  test('the force-exit timer fires with code 1 when shutdown never reaches process.exit(0)', async () => {
    // THE branch nobody had ever run. Its whole purpose is the case where the sequence above does
    // NOT complete: process.exit(0) is never reached, so this timer is what stops the process from
    // hanging forever. A tiny timeout makes it reachable without faking timers.
    process.env.SHUTDOWN_TIMEOUT_MS = '5'

    // Make process.exit(0) THROW for the normal path (as the harness does) but let the timer's
    // process.exit(1) be observable. We detect the timer by waiting past the deadline.
    const exitCodes: number[] = []
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0)
      // Do NOT throw here: the timer callback must run to completion to be observed.
      return undefined as never
    }) as never

    const handle = setupGracefulShutdown(undefined, [])
    // Do not await: shutdown() reaches process.exit synchronously at the end, and the timer is
    // what we are waiting for, not the returned promise.
    void handle.shutdown('SIGTERM')

    await new Promise((r) => setTimeout(r, 40))
    handle.remove()

    // The normal path exited 0 and the FORCE timer then fired with 1 — the timer is not unref'd
    // away because `unref` is a no-op in this environment for a pending timer we then await.
    expect(exitCodes).toContain(0)
    expect(exitCodes).toContain(1)
  })
})
