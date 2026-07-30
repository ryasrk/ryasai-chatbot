import { type ZodSchema } from 'zod'
import type { LlmMessage } from '@/lib/llm-client'
import type { LlmRuntimeConfig } from '@/lib/llm-config'

export function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    /* fall through to regex */
  }
  // ponytail: greedy match for first {...} or [...] block — handles surrounding prose.
  const objMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objMatch) {
    try { return JSON.parse(objMatch[0]) } catch { /* continue */ }
  }
  const arrMatch = trimmed.match(/\[[\s\S]*\]/)
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]) } catch { /* continue */ }
  }
  throw new Error('No valid JSON found in LLM output')
}

export async function chatWithSchema<T>(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  schema: ZodSchema<T>,
  maxRetries: number = 2,
): Promise<T> {
  const { chatOnce } = await import('@/lib/llm-client')
  const attempts = messages.slice()
  let lastError = ''

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const raw = await chatOnce(cfg, attempts, 0, 'constrained-output')
    let parsed: unknown
    try {
      parsed = extractJson(raw)
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      attempts.push({ role: 'assistant', content: raw })
      attempts.push({ role: 'user', content: `Your previous response was not valid JSON: ${lastError}. Please respond with valid JSON matching this schema: ${schemaDescription(schema)}` })
      continue
    }

    const result = schema.safeParse(parsed)
    if (result.success) return result.data

    lastError = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    attempts.push({ role: 'assistant', content: raw })
    attempts.push({ role: 'user', content: `Validation failed: ${lastError}. Please respond with valid JSON matching this schema: ${schemaDescription(schema)}` })
  }

  throw new Error(`chatWithSchema failed after ${maxRetries + 1} attempts. Last error: ${lastError}`)
}

function schemaDescription<T>(schema: ZodSchema<T>): string {
  const desc = (schema as unknown as { description?: string }).description
  return desc ?? JSON.stringify(schema, null, 2).slice(0, 500)
}
