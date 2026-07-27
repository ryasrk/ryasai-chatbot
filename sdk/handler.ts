import type { PluginRequest, PluginResponse, HttpLikeRequest, HttpLikeResponse } from './types'

/**
 * Wrap a plugin handler into an HTTP webhook adapter compatible with
 * Express / Next.js / Node http handlers. The wrapped function receives a
 * parsed PluginRequest and returns a PluginResponse (or throws).
 *
 * Usage (Next.js route):
 *   export const POST = wrapHandler(async (req) => ({ ok: true, output: req.input }))
 */
export function wrapHandler(
  fn: (req: PluginRequest) => Promise<PluginResponse> | PluginResponse,
): (req: HttpLikeRequest, res: HttpLikeResponse) => Promise<void> {
  return async (req, res) => {
    const started = Date.now()
    const pluginReq = normalizeRequest(req)
    try {
      const result = await fn(pluginReq)
      const latencyMs = Date.now() - started
      const payload: PluginResponse = {
        ...result,
        latencyMs: result.latencyMs ?? latencyMs,
      }
      res.setHeader('Content-Type', 'application/json')
      res.status(payload.ok ? 200 : 502)
      res.json(payload)
    } catch (e) {
      const latencyMs = Date.now() - started
      res.setHeader('Content-Type', 'application/json')
      res.status(502)
      res.json({
        ok: false,
        output: '',
        error: e instanceof Error ? e.message : String(e),
        latencyMs,
      } satisfies PluginResponse)
    }
  }
}

function normalizeRequest(req: HttpLikeRequest): PluginRequest {
  const body = req.body
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.toolId === 'string' || typeof b.input === 'string') {
      return {
        toolId: typeof b.toolId === 'string' ? b.toolId : '',
        input: typeof b.input === 'string' ? b.input : '',
        requestId: typeof b.requestId === 'string' ? b.requestId : undefined,
      }
    }
  }
  // ponytail: unknown body shape — treat the whole body as the input string.
  return {
    toolId: '',
    input: typeof body === 'string' ? body : JSON.stringify(body ?? ''),
  }
}
