// ponytail: graceful no-op — OLLAMA_BASE_URL must be explicitly set to enable.
// Default localhost value is the conventional target users configure, not an auto-enable.

export interface OllamaConfig {
  baseUrl: string
  model: string
}

export function getOllamaConfig(): OllamaConfig | null {
  const baseUrl = process.env.OLLAMA_BASE_URL
  if (!baseUrl) return null
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    model: process.env.OLLAMA_MODEL ?? 'llama3.2',
  }
}

export async function ollamaChat(
  messages: Array<{ role: string; content: string }>,
  opts?: { temperature?: number; stream?: boolean },
): Promise<string | null> {
  const cfg = getOllamaConfig()
  if (!cfg) return null
  const res = await fetch(`${cfg.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: opts?.stream ?? false,
      options: opts?.temperature != null ? { temperature: opts.temperature } : undefined,
    }),
  })
  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status} ${res.statusText}`)
  const data = (await res.json()) as { message?: { content?: string } }
  return data.message?.content ?? ''
}

export async function ollamaEmbed(texts: string[]): Promise<number[][] | null> {
  const cfg = getOllamaConfig()
  if (!cfg) return null
  const out: number[][] = []
  for (const text of texts) {
    const res = await fetch(`${cfg.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, prompt: text }),
    })
    if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`)
    const data = (await res.json()) as { embedding?: number[] }
    out.push(data.embedding ?? [])
  }
  return out
}
