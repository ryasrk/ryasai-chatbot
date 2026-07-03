/**
 * Standalone OpenAI-compatible stub used by the e2e test suite.
 *
 * Answers:
 *   GET  .../models           → { data: [{ id: 'mock-model' }] }
 *   POST .../chat/completions → fixed reply
 *   POST .../embeddings       → zero-ish vectors (64 dims)
 *
 * Implemented with Node's http module so it works both when imported
 * directly (by Playwright's Node-based global-setup) and when run via
 * `bun run e2e/mock-llm.ts`.
 */
import http from 'http'

export function startMockLlm(port = 4545): http.Server {
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404).end()
      return
    }
    const url = new URL(req.url, `http://localhost:${port}`)

    // Collect request body for POST endpoints
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8')

    // --- models list ---
    if (url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'mock-model', object: 'model', owned_by: 'e2e' }],
        }),
      )
      return
    }

    // --- chat completions ---
    if (url.pathname.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'mock-chatcmpl',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'mock-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Jawaban uji dari mock LLM.',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 5,
            total_tokens: 10,
          },
        }),
      )
      return
    }

    // --- embeddings ---
    if (url.pathname.endsWith('/embeddings')) {
      let inputCount = 1
      try {
        const body = JSON.parse(rawBody || '{}')
        inputCount = Array.isArray(body.input) ? body.input.length : 1
      } catch {
        /* default to 1 */
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: Array.from({ length: inputCount }, (_, i) => ({
            index: i,
            embedding: new Array(64).fill(0.001),
          })),
          model: 'mock-embedding',
          usage: { prompt_tokens: inputCount, total_tokens: inputCount },
        }),
      )
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  server.listen(port)
  return server
}

// When run directly via bun
if ((globalThis as Record<string, unknown>).Bun) {
  startMockLlm()
  console.log('mock llm on :4545')
}
