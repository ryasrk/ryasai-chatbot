/**
 * What does a user see when their OWN key is dead?
 * Simulates a revoked key / exhausted credit / wrong model name.
 */
const cases = [
  { status: 401, body: '{"error":{"message":"Incorrect API key provided: sk-abc...","type":"invalid_request_error"}}' },
  { status: 402, body: '{"error":{"message":"Insufficient credits. Please top up.","type":"insufficient_quota"}}' },
  { status: 404, body: '{"error":{"message":"The model `gpt-9-turbo` does not exist","type":"invalid_request_error"}}' },
  { status: 400, body: '{"error":{"message":"This model does not support tools","type":"invalid_request_error"}}' },
]

async function main() {
  const originalFetch = global.fetch
  const { chatOnce } = await import('../src/lib/llm-client')
  for (const c of cases) {
    global.fetch = (async () => ({
      ok: false, status: c.status,
      text: async () => c.body,
      json: async () => JSON.parse(c.body),
    })) as unknown as typeof fetch
    try {
      await chatOnce({
        id: 'test', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-dead', model: 'gpt-4o-mini',
      }, [{ role: 'user', content: 'hi' }])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const kind = (e as { failure?: { kind: string; hint: string } }).failure
      console.log(`HTTP ${c.status} -> kind=${kind?.kind ?? 'NONE'}`)
      console.log(`   raw: ${msg.slice(0, 80)}`)
      console.log(`   HINT: ${kind?.hint ?? '(no hint — user gets a generic message)'}`)
    }
  }
  global.fetch = originalFetch
  process.exit(0)
}
main()
