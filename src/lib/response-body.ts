/** Read a bounded UTF-8 prefix and cancel the remaining transfer. Read failures propagate. */
export async function readResponseBody(
  response: Pick<Response, 'body'>,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid response byte limit')
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = limit - bytes
      text += decoder.decode(value.subarray(0, remaining), { stream: true })
      bytes += Math.min(value.byteLength, remaining)
      if (value.byteLength > remaining) {
        truncated = true
        break
      }
    }
    text += decoder.decode()
    return { text, truncated }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
