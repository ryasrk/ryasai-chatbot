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

/**
 * Mock behaviour, settable through `POST /__mock/control`.
 *
 * `toolCall` non-null makes the FIRST completion of a conversation emit a tool
 * call for that function name, and the follow-up completion return
 * MOCK_ANSWER_AFTER_TOOL. `verifyToolCallShape` makes the mock reject (400) any
 * assistant message whose tool_call lacks `type`/`function` — the wire-shape
 * regression guard, enforced by the server rather than by test diligence.
 */
export const mockState: {
  toolCall: string | null
  verifyToolCallShape: boolean
  shapeViolations: number
} = { toolCall: null, verifyToolCallShape: false, shapeViolations: 0 }

export function startMockLlm(port = 4545): http.Server {
  mockState.toolCall = null
  mockState.verifyToolCallShape = false
  mockState.shapeViolations = 0
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

    // --- control channel ---------------------------------------------------
    // The app's LLM client sends ONLY Content-Type/Authorization, so a request
    // header cannot carry test directives. The e2e suite configures the mock
    // out-of-band instead; this keeps production transport untouched.
    if (url.pathname === '/__mock/control' && req.method === 'POST') {
      try {
        const cmd = JSON.parse(rawBody || '{}') as {
          toolCall?: string | null
          verifyToolCallShape?: boolean
        }
        if ('toolCall' in cmd) mockState.toolCall = cmd.toolCall ?? null
        if ('verifyToolCallShape' in cmd) mockState.verifyToolCallShape = !!cmd.verifyToolCallShape
        mockState.shapeViolations = 0
      } catch {
        /* ignore malformed control payloads */
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, state: mockState }))
      return
    }
    if (url.pathname === '/__mock/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(mockState))
      return
    }

    // --- chat completions ---
    if (url.pathname.endsWith('/chat/completions')) {
      // PROGRAMMABLE TOOL-CALL MODE.
      //
      // The ReAct orchestrator can only be exercised end-to-end if the model
      // actually emits a tool call, and the default fixed-text reply never does.
      // A test opts in with the `x-e2e-tool-call` header naming the function to
      // call; the mock then answers with a spec-correct tool_calls payload.
      //
      // `x-e2e-verify-toolcall-shape: 1` additionally makes the mock REFUSE with
      // 400 when an incoming assistant message carries a tool_call missing
      // `type`/`function` — the 2026-09 regression that silently broke every
      // multi-round turn. That turns the wire contract into a server-enforced
      // assertion instead of something each test must remember to check.
      const wantsToolCall = mockState.toolCall
      const verifyShape = mockState.verifyToolCallShape ? '1' : undefined

      let parsedBody: {
        messages?: Array<{ role?: string; tool_calls?: Array<Record<string, unknown>> }>
      } = {}
      try {
        parsedBody = JSON.parse(rawBody || '{}')
      } catch {
        /* fall through with {} */
      }

      if (verifyShape === '1') {
        for (const m of parsedBody.messages ?? []) {
          if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue
          for (const tc of m.tool_calls) {
            const fn = tc.function as { name?: string } | undefined
            if (tc.type !== 'function' || !fn || typeof fn.name !== 'string') {
              mockState.shapeViolations += 1
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(
                JSON.stringify({
                  error: {
                    message:
                      'malformed tool_call on the wire: expected { id, type: "function", function: { name, arguments } }',
                    type: 'invalid_request_error',
                  },
                }),
              )
              return
            }
          }
        }
      }

      const hasToolResult = (parsedBody.messages ?? []).some((m) => m.role === 'tool')

      if (wantsToolCall && !hasToolResult) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'mock-toolcall',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_mock_1',
                      type: 'function',
                      function: {
                        name: wantsToolCall,
                        arguments: JSON.stringify({ query: 'mock query' }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        )
        return
      }

      // Second round (a tool result is present) or no tool requested: final text.
      const finalText = hasToolResult ? 'MOCK_ANSWER_AFTER_TOOL' : 'Jawaban uji dari mock LLM.'
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
                content: finalText,
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
