/**
 * Minimal OpenAI-compatible client for the live-eval tooling (corpus generation, question generation, judging).
 *
 * The endpoint and key are read from an org's stored `LlmConfig` (decrypted in-process with the install's own
 * ENCRYPTION key) so no credential is ever written to disk or printed. `EVAL_SOURCE_DATABASE_URL` and
 * `EVAL_SOURCE_ORG_ID` name where that config lives. The MODEL is always chosen by the caller: the eval keeps the
 * generator under test, the question author and the judge on three different model families.
 */
import { PrismaClient } from '@prisma/client'
import { decryptConfig } from '../../src/lib/crypto'

let cached: { baseUrl: string; apiKey: string } | null = null

export async function endpoint(): Promise<{ baseUrl: string; apiKey: string }> {
  if (cached) return cached
  const url = process.env.EVAL_SOURCE_DATABASE_URL
  const orgId = process.env.EVAL_SOURCE_ORG_ID
  if (!url || !orgId) throw new Error('EVAL_SOURCE_DATABASE_URL and EVAL_SOURCE_ORG_ID are required')
  const prisma = new PrismaClient({ datasourceUrl: url })
  try {
    const row = await prisma.llmConfig.findFirst({ where: { organizationId: orgId, purpose: 'chat' } })
    if (!row?.baseUrl || !row.encryptedApiKey) throw new Error('source org has no chat LLM config')
    const apiKey = String(decryptConfig(row.encryptedApiKey).apiKey ?? '')
    if (!apiKey) throw new Error('source org LLM key could not be decrypted')
    cached = { baseUrl: row.baseUrl.replace(/\/+$/, ''), apiKey }
    return cached
  } finally {
    await prisma.$disconnect()
  }
}

export async function complete(
  model: string,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  opts: { maxTokens?: number; temperature?: number; json?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const { baseUrl, apiKey } = await endpoint()
  const base = /\/v1$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 4000,
        temperature: opts.temperature ?? 0,
        stream: false,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 240_000),
    }).catch((e: unknown) => ({ ok: false, status: 0, text: async () => String(e) }) as Response)
    if (res.ok) {
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const text = body.choices?.[0]?.message?.content ?? ''
      if (text.trim()) return text
    }
    // 429/5xx/transport/empty: back off and retry; anything else is a configuration error worth surfacing.
    const status = res.status
    if (status && status < 500 && status !== 429 && status !== 200) throw new Error(`LLM ${model} HTTP ${status}: ${(await res.text()).slice(0, 200)}`)
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt))
  }
  throw new Error(`LLM ${model} failed after retries`)
}

/** Parse the first JSON object/array in a model reply (tolerates code fences and prose around it). */
export function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const text = fenced ? fenced[1] : raw
  const start = text.search(/[[{]/)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  return JSON.parse(text.slice(start, end + 1)) as T
}

/** Run `fn` over `items` with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}
