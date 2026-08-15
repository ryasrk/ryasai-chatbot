/**
 * Shared SSE client for benchmark runners.
 *
 * The chat send route ALWAYS returns `text/event-stream` (SSE), never plain
 * JSON — even when `Accept: application/json` is sent. The benchmark runners
 * were calling `res.json()` on the SSE stream, which threw "Failed to parse
 * JSON" on every single question.
 *
 * This module reads the SSE stream, accumulates tokens, and extracts the
 * final answer + citations + toolRuns from the `answer` and `done` events.
 *
 * SSE event format from the send route:
 *   event: user_message  → { id, sessionId, sender, text, createdAt }
 *   event: thinking      → { content }
 *   event: tool_start    → { tool, label }
 *   event: tool_end      → { tool, status, latencyMs, hasResults }
 *   event: token         → { content }          (streamed answer text)
 *   event: answer        → { content, citations, chartData, messageId, integration, toolHasResults }
 *   event: done          → { messageId, latencyMs }
 *   event: error         → { code, message }
 */

/**
 * Bun 1.3's AbortSignal.timeout() crashes on streaming fetch responses with
 * a DOM-exception dump. This manual replacement works identically.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const ac = new AbortController()
  setTimeout(() => ac.abort(new Error(`timeout after ${ms}ms`)), ms)
  return ac.signal
}

export interface SseChatResult {
  answer: string
  citations: Array<{ type?: string; source?: string }>
  toolRuns: Array<{ type?: string; status?: string }>
  error?: { code: string; message: string }
}

/**
 * Consume an SSE response from the chat send endpoint.
 * Reads until `done` or `error` event, accumulating token content.
 */
export async function consumeSseStream(res: Response): Promise<SseChatResult> {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`send failed: HTTP ${res.status} ${body.slice(0, 200)}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('no response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let answer = ''
  let citations: Array<{ type?: string; source?: string }> = []
  let toolRuns: Array<{ type?: string; status?: string }> = []
  let error: { code: string; message: string } | undefined

  let currentEvent = ''

  const onEvent = (event: string, data: string) => {
    if (!data.trim()) return
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(data)
    } catch {
      return // ignore malformed lines
    }

    switch (event) {
      case 'token': {
        const content = payload.content
        if (typeof content === 'string') answer += content
        break
      }
      case 'tool_start': {
        const tool = payload.tool as string | undefined
        if (tool && tool !== 'CHAT') {
          toolRuns.push({ type: tool, status: 'running' })
        }
        break
      }
      case 'tool_end': {
        const tool = payload.tool as string | undefined
        const status = payload.status as string | undefined
        // Update the last toolRun with same type
        const last = toolRuns.filter((t) => t.type === tool).pop()
        if (last && status) last.status = status
        break
      }
      case 'answer': {
        // Full answer from server (may be complete or partial)
        const content = payload.content
        if (typeof content === 'string' && content.length > answer.length) {
          answer = content
        }
        const cits = payload.citations
        if (Array.isArray(cits)) citations = cits
        break
      }
      case 'error': {
        error = {
          code: (payload.code as string) ?? 'UNKNOWN',
          message: (payload.message as string) ?? 'Unknown error',
        }
        break
      }
      // done, thinking, user_message — no data to extract
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE blocks (separated by \n\n)
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)

        let event = ''
        let dataLines: string[] = []
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
        }
        if (event && dataLines.length > 0) {
          onEvent(event, dataLines.join('\n'))
        }
      }
    }
  } finally {
    reader.releaseLock?.()
  }

  return { answer, citations, toolRuns, error }
}
