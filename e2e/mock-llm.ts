/**
 * Standalone OpenAI-compatible stub used by the e2e test suite.
 *
 * Answers:
 *   GET  .../models           → { data: [{ id: 'mock-model' }] }
 *   POST .../chat/completions → fixed reply
 *   POST .../embeddings       → deterministic, input-derived 384-dim vectors
 *
 * Implemented with Node's http module so it works both when imported
 * directly (by Playwright's Node-based global-setup) and when run via
 * `bun run e2e/mock-llm.ts`.
 *
 * WHY THE EMBEDDINGS ARE 384-DIM AND INPUT-DERIVED
 * ----------------------------------------------------------------------------
 * They used to be `new Array(64).fill(0.001)`: the same vector for every input, at a
 * dimension the storage column does not accept. That made the vector leg dead in e2e,
 * and silently so — `canWriteVectorColumn` (`src/lib/embeddings.ts`) compares the
 * incoming dimension against the live `DocumentChunk.embedding` column (`vector(384)`,
 * from prisma/schema.prisma) and stores `embeddingJson` only on a mismatch, warning
 * once. Measured before this change: the e2e DB held 1 chunk and 0 non-null
 * `embedding`.
 *
 * The consequence for THIS suite was that the fused retrieval order equalled the
 * lexical order: with `vectorRanking` empty, `fuseRankings` received one non-empty
 * list, and `1/(k + rank)` is strictly decreasing in `rank` for every `k > 0`, so the
 * result is identical for ANY `k`. A fusion change was therefore not merely hard to
 * observe in e2e, but arithmetically unobservable — which is what
 * docs/retrieval-production-integration-plan.md §8.2 records.
 *
 * Both properties matter and neither is sufficient alone: matching the dimension lets
 * the row reach pgvector at all, and deriving the vector from the text stops every
 * cosine being 1.0 (which would leave the leg present but carrying no signal).
 *
 * DETERMINISM IS REQUIRED. The vector is a hash of the input, never random: a random
 * vector makes the suite flaky, and a flaky e2e is worse than a narrow one. Note this
 * is a BAG OF TOKENS, not a language model — it is enough to make the vector leg a
 * real, deterministic participant in the fusion, and it is NOT a measurement of
 * semantic quality. Real retrieval quality is measured by
 * `benchmark/real-prose-arm.ts` against a real embedder.
 */
import http from 'http'
import { createHash } from 'node:crypto'

/** Must equal the dimension of `DocumentChunk.embedding` in prisma/schema.prisma. */
export const MOCK_EMBEDDING_DIMS = 384


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

/**
 * Deterministic pseudo-embedding: a fixed-dimension unit vector derived from the text.
 *
 * Seeded by a SHA-256 of the normalised text, so the same text always produces the same
 * vector (a random vector would make the suite flaky) and different text produces
 * different vectors (the old constant vector would not). Tokens also fold in, so two
 * passages sharing vocabulary land closer than two that share none — the property the
 * vector leg needs in order to contribute anything to a fused ranking.
 *
 * Explicitly NOT a semantic model: no morphology, no cross-lingual mapping. It exists so
 * the retrieval pipeline has a live, deterministic vector leg in e2e.
 */
export function mockEmbedding(text: string): number[] {
  const vec = new Array<number>(MOCK_EMBEDDING_DIMS).fill(0)
  const normalised = text.toLowerCase()
  // Per-token contributions, so shared vocabulary moves the vector in a shared direction.
  for (const token of normalised.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    addHashed(vec, token, 1)
  }
  // The whole string as well, so a single-token or empty input is still distinguished.
  addHashed(vec, normalised, 0.5)
  // Normalise to a unit vector: pgvector's cosine operator is scale-invariant, so this
  // only keeps the fixture readable, but a zero vector would make cosine undefined.
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
  if (norm === 0) {
    vec[0] = 1
    return vec
  }
  return vec.map((v) => v / norm)
}

/** Add a hashed direction for `key` into `vec`, deterministically. */
function addHashed(vec: number[], key: string, weight: number): void {
  const digest = createHash('sha256').update(key).digest()
  // A few independent indices per key from the one digest, plus a sign per index, so
  // collisions cancel instead of accumulating in a single direction.
  for (let i = 0; i < 4; i++) {
    const idx = ((digest[i * 2] << 8) | digest[i * 2 + 1]) % MOCK_EMBEDDING_DIMS
    const sign = digest[8 + i] % 2 === 0 ? 1 : -1
    vec[idx] += sign * weight
  }
}

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
      let inputs: string[] = ['']
      try {
        const body = JSON.parse(rawBody || '{}')
        const raw = body.input
        // The OpenAI wire format accepts a string or an array of strings (and token
        // arrays, which this stub treats as opaque). Normalise to a string list so one
        // code path produces the vectors.
        inputs = Array.isArray(raw) ? raw.map((v: unknown) => String(v)) : [String(raw ?? '')]
      } catch {
        /* keep the default single input */
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: inputs.map((text, i) => ({
            index: i,
            embedding: mockEmbedding(text),
          })),
          model: 'mock-embedding',
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
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
