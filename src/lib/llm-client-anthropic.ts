/**
 * LLM client — Anthropic-native request builder.
 * Depends on: llm-client-types.
 */
import type { LlmMessage, LlmContentPart, LlmToolDef, LlmResponseFormat } from './llm-client-types'

const MAX_TOKENS_ANTHROPIC = 4096

// ---------------------------------------------------------------------------
// Anthropic request builder — concatenates ALL system messages.
// (Fixes the bug where only the first system message was kept, dropping
// memory context, chat history, and prompt prefixes on Anthropic.)
// ---------------------------------------------------------------------------

function toAnthropicContent(
  content: string | LlmContentPart[] | null,
): string | Array<Record<string, unknown>> {
  if (content === null) return ''
  if (typeof content === 'string') return content
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const url = part.image_url.url
    const m = url.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/)
    if (m) {
      return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
    }
    return { type: 'image', source: { type: 'url', url } }
  })
}

export function buildAnthropicBody(
  messages: LlmMessage[],
  temperature: number,
  stream: boolean = false,
  tools?: LlmToolDef[],
  responseFormat?: LlmResponseFormat,
): Record<string, unknown> {
  const systemParts = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
  const nonSystem = messages.filter((m) => m.role !== 'system')
  const body: Record<string, unknown> = {
    max_tokens: MAX_TOKENS_ANTHROPIC,
    temperature,
    messages: nonSystem.map((m) => ({
      role: m.role,
      content: toAnthropicContent(m.content),
    })),
  }
  if (systemParts.length > 0) {
    body.system = [
      {
        type: 'text',
        text: systemParts.join('\n\n'),
        cache_control: { type: 'ephemeral' },
      },
    ]
  }
  if (stream) body.stream = true
  if (responseFormat) {
    // ponytail: Anthropic has no native structured output — synthesize a tool
    // with the schema as input_schema, force tool_choice, parse tool_use input.
    const synthTool = {
      name: responseFormat.json_schema.name,
      description: responseFormat.json_schema.description ?? responseFormat.json_schema.name,
      input_schema: responseFormat.json_schema.schema,
    }
    body.tools = [synthTool]
    body.tool_choice = { type: 'tool', name: responseFormat.json_schema.name }
  } else if (tools && tools.length > 0) {
    const anthropicTools: Array<{
      name: string
      description: string
      input_schema: Record<string, unknown>
      cache_control?: { type: string }
    }> = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }))
    anthropicTools[anthropicTools.length - 1].cache_control = { type: 'ephemeral' }
    body.tools = anthropicTools
  }
  return body
}
