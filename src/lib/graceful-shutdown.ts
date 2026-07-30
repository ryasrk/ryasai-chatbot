/**
 * Graceful shutdown — SIGTERM/SIGINT handler with cleanup + timeout.
 * ----------------------------------------------------------------------------
 * ponytail: sequential cleanup (server.close → cleanupFns → exit). Force-exit
 * timer (unref'd) prevents hanging on stuck connections.
 *
 * Wire into the standalone server:
 *   const handle = setupGracefulShutdown(server, [() => db.$disconnect(), disconnectRedis])
 */
export interface Shutdownable {
  close?: () => Promise<void> | void
}

export interface GracefulShutdownHandle {
  shutdown: (signal: string) => Promise<void>
  remove: () => void
}

export function setupGracefulShutdown(
  server?: Shutdownable,
  cleanupFns: Array<() => Promise<void> | void> = [],
): GracefulShutdownHandle {
  const timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000)
  let shuttingDown = false

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[graceful-shutdown] ${signal} received, shutting down...`)

    if (server?.close) {
      try {
        await server.close()
      } catch (e) {
        console.error('[graceful-shutdown] server.close error:', e)
      }
    }

    for (const fn of cleanupFns) {
      try {
        await fn()
      } catch (e) {
        console.error('[graceful-shutdown] cleanup error:', e)
      }
    }

    const forceTimer = setTimeout(() => {
      console.error('[graceful-shutdown] timeout reached, forcing exit')
      process.exit(1)
    }, timeoutMs)
    forceTimer.unref?.()

    process.exit(0)
  }

  const onSigTerm = () => void shutdown('SIGTERM')
  const onSigInt = () => void shutdown('SIGINT')
  process.on('SIGTERM', onSigTerm)
  process.on('SIGINT', onSigInt)

  return {
    shutdown,
    remove: () => {
      process.off('SIGTERM', onSigTerm)
      process.off('SIGINT', onSigInt)
    },
  }
}
