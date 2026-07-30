export class ToolTimeoutError extends Error {
  toolName: string
  durationMs: number
  constructor(toolName: string, durationMs: number) {
    super(`Tool "${toolName}" timed out after ${durationMs}ms`)
    this.name = 'ToolTimeoutError'
    this.toolName = toolName
    this.durationMs = durationMs
  }
}

const DEFAULT_TIMEOUT = () => Number(process.env.TOOL_TIMEOUT_MS ?? 30000)

function getToolTimeout(toolName: string): number {
  const envKey = `TOOL_TIMEOUT_${toolName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MS`
  const envVal = process.env[envKey]
  if (envVal) {
    const n = Number(envVal)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_TIMEOUT()
}

export async function withToolSandbox<T>(
  toolName: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const timeout = timeoutMs ?? getToolTimeout(toolName)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError(toolName, timeout)), timeout)
  })

  try {
    return await Promise.race([fn(), timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
