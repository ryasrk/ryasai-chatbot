/**
 * Anthropic-native request builder.
 *
 * WHY THIS FILE EXISTS. `llm-client-anthropic.ts` had ZERO instrumented lines — no test imported
 * it, even transitively, so the whole module ran uninstrumented (coverage-honest.py could not
 * even compute a number for it). Yet it builds EVERY request for an org configured against
 * Anthropic: two call sites in llm-client.ts, one non-streaming and one streaming. A defect here
 * is not a cosmetic bug — it is the difference between the model seeing the system prompt and
 * the org's memory context, or not seeing them at all.
 *
 * The file's own header records a bug that already happened once: "only the first system message
 * was kept, dropping memory context, chat history, and prompt prefixes on Anthropic". That is the
 * single most important property to pin, and it is asserted below with several system messages.
 *
 * Pure function under test: no network, no mocks needed.
 */
import { describe, expect, test } from 'bun:test'
import { buildAnthropicBody } from './llm-client-anthropic'
import type { LlmMessage, LlmToolDef } from './llm-client-types'

const sys = (text: string): LlmMessage => ({ role: 'system', content: text })
const user = (text: string): LlmMessage => ({ role: 'user', content: text })

describe('buildAnthropicBody — system prompt handling', () => {
  test('ALL system messages are concatenated, never just the first one', () => {
    // THE regression this module documents. Three separate system messages routinely occur in
    // this codebase: the org systemPrompt, the injected memory/history prefix, and a tool note.
    // Keeping only the first silently dropped the other two on every Anthropic request.
    const body = buildAnthropicBody(
      [sys('SYSTEM-ONE'), sys('SYSTEM-TWO'), sys('SYSTEM-THREE'), user('hi')],
      0,
    ) as { system: Array<{ text: string }> }

    expect(body.system).toHaveLength(1)
    expect(body.system[0]!.text).toBe('SYSTEM-ONE\n\nSYSTEM-TWO\n\nSYSTEM-THREE')
  })

  test('system content is sent as a top-level `system` field, not as a message role', () => {
    // Anthropic rejects a message with role 'system'; it must be hoisted to the body root.
    const body = buildAnthropicBody([sys('be nice'), user('hi')], 0) as {
      system: unknown
      messages: Array<{ role: string }>
    }
    expect(body.messages.map((m) => m.role)).toEqual(['user'])
  })

  test('no system message means no `system` KEY at all', () => {
    // Sending `system: undefined` vs omitting it differs over the wire; omitting is what the
    // guarded `if (systemParts.length > 0)` is for.
    const body = buildAnthropicBody([user('hi')], 0)
    expect('system' in body).toBe(false)
  })

  test('an EMPTY string system message is still sent (it is present, not absent)', () => {
    // Pinned as MEASURED: the guard checks array LENGTH, not emptiness, so an empty system
    // message produces `system: [{ text: '' }]`. Recorded rather than "fixed" because changing
    // it is a wire-level behaviour change with no reported defect behind it.
    const body = buildAnthropicBody([sys(''), user('hi')], 0) as { system: Array<{ text: string }> }
    expect('system' in body).toBe(true)
    expect(body.system[0]!.text).toBe('')
  })

  test('the system block is marked ephemeral for prompt caching', () => {
    // cache_control is what makes a long system prompt cheap on repeat calls. Dropping it is a
    // silent cost regression, not a correctness one, so it would never surface as a failure.
    const body = buildAnthropicBody([sys('long prompt')], 0) as {
      system: Array<{ cache_control: { type: string } }>
    }
    expect(body.system[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })
})

describe('buildAnthropicBody — message shape', () => {
  test('assistant and tool messages survive as roles, in order', () => {
    const body = buildAnthropicBody(
      [user('q'), { role: 'assistant', content: 'a' }, { role: 'tool', content: 'r' }],
      0,
    ) as { messages: Array<{ role: string }> }
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })

  test('a null content becomes an empty string, not `null`', () => {
    // Anthropic rejects a null content. An assistant turn carrying only tool_calls has
    // content: null in our own type, so this is a real shape, not a hypothetical.
    const body = buildAnthropicBody([{ role: 'assistant', content: null }], 0) as {
      messages: Array<{ content: unknown }>
    }
    expect(body.messages[0]!.content).toBe('')
  })

  test('max_tokens and temperature are set from the constants/argument', () => {
    const body = buildAnthropicBody([user('x')], 0.7) as { max_tokens: number; temperature: number }
    expect(body.max_tokens).toBe(4096)
    expect(body.temperature).toBe(0.7)
  })

  test('stream is ABSENT unless requested, and `true` when it is', () => {
    expect('stream' in buildAnthropicBody([user('x')], 0)).toBe(false)
    expect((buildAnthropicBody([user('x')], 0, true) as { stream: boolean }).stream).toBe(true)
  })
})

describe('buildAnthropicBody — multimodal content translation', () => {
  test('a data: image URL becomes a base64 image block with the parsed media type', () => {
    // OpenAI-style `image_url` is our internal shape; Anthropic wants {type:'image', source:{...}}.
    // A raw passthrough would be rejected by the API.
    const body = buildAnthropicBody(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
      0,
    ) as { messages: Array<{ content: Array<Record<string, unknown>> }> }

    const parts = body.messages[0]!.content
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(parts[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    })
  })

  test('the media type is taken from the data URL, so jpeg stays jpeg', () => {
    const body = buildAnthropicBody(
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }] }],
      0,
    ) as { messages: Array<{ content: Array<{ source: { media_type: string } }> }> }
    expect(body.messages[0]!.content[0]!.source.media_type).toBe('image/jpeg')
  })

  test('a NON-data image URL becomes a url source instead of being dropped', () => {
    const body = buildAnthropicBody(
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://cdn.test/a.png' } }] }],
      0,
    ) as { messages: Array<{ content: Array<Record<string, unknown>> }> }
    expect(body.messages[0]!.content[0]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://cdn.test/a.png' },
    })
  })

  test('a base64 payload containing an "=" pad still parses (the regex is greedy on `.+`)', () => {
    // Real base64 ends in '=' padding, which is the kind of character a stricter URL regex would
    // refuse. If this broke, every uploaded screenshot would silently become a url source.
    const body = buildAnthropicBody(
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==BB==' } }] }],
      0,
    ) as { messages: Array<{ content: Array<{ source: Record<string, string> }> }> }
    expect(body.messages[0]!.content[0]!.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: 'AA==BB==',
    })
  })
})

describe('buildAnthropicBody — tools', () => {
  const TOOL: LlmToolDef = {
    type: 'function',
    function: {
      name: 'run_sql',
      description: 'run a query',
      parameters: { type: 'object', properties: { sql: { type: 'string' } } },
    },
  }

  test('a tool def is translated from {type,function} to a flat {name,input_schema}', () => {
    // The nesting differs between the two APIs; sending our internal shape would be rejected.
    const body = buildAnthropicBody([user('x')], 0, false, [TOOL]) as {
      tools: Array<Record<string, unknown>>
    }
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]!.name).toBe('run_sql')
    expect(body.tools[0]!.description).toBe('run a query')
    expect(body.tools[0]!.input_schema).toEqual(TOOL.function.parameters)
    // The OpenAI-style discriminator must NOT leak into the Anthropic payload.
    expect('type' in body.tools[0]!).toBe(false)
    expect('function' in body.tools[0]!).toBe(false)
  })

  test('cache_control goes on the LAST tool only', () => {
    // Anthropic caches the tool block up to the marker, so marking every tool adds cost and no
    // benefit. Marking the wrong one changes what gets cached.
    const second: LlmToolDef = { ...TOOL, function: { ...TOOL.function, name: 'second' } }
    const body = buildAnthropicBody([user('x')], 0, false, [TOOL, second]) as {
      tools: Array<{ name: string; cache_control?: { type: string } }>
    }
    expect(body.tools[0]!.cache_control).toBeUndefined()
    expect(body.tools[1]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  test('an EMPTY tools array does not set a `tools` key', () => {
    // `tools: []` is rejected by Anthropic, so the length check is load-bearing.
    expect('tools' in buildAnthropicBody([user('x')], 0, false, [])).toBe(false)
  })

  test('no tools argument at all does not set a `tools` key', () => {
    expect('tools' in buildAnthropicBody([user('x')], 0)).toBe(false)
  })
})

describe('buildAnthropicBody — structured output via a synthesized forced tool', () => {
  const FORMAT = {
    type: 'json_schema' as const,
    json_schema: {
      name: 'sql_plan',
      description: 'a plan',
      schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    },
  }

  test('Anthropic has no structured output, so a tool with the schema is synthesized and FORCED', () => {
    // Without tool_choice forcing it, the model may answer in prose and the caller's JSON.parse
    // fails. This is the mechanism that makes structured output work at all on Anthropic.
    const body = buildAnthropicBody([user('x')], 0, false, undefined, FORMAT) as {
      tools: Array<Record<string, unknown>>
      tool_choice: Record<string, unknown>
    }
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]!.name).toBe('sql_plan')
    expect(body.tools[0]!.input_schema).toEqual(FORMAT.json_schema.schema)
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'sql_plan' })
  })

  test('responseFormat TAKES PRECEDENCE over an explicit tools list', () => {
    // A caller passing both must get the structured-output tool ONLY; emitting both would let
    // the model call the wrong tool and break the JSON contract the caller is relying on.
    const body = buildAnthropicBody(
      [user('x')],
      0,
      false,
      [{ type: 'function', function: { name: 'other', description: 'd', parameters: {} } }],
      FORMAT,
    ) as { tools: Array<{ name: string }>; tool_choice: unknown }
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0]!.name).toBe('sql_plan')
  })

  test('a missing description falls back to the schema NAME, never `undefined`', () => {
    const body = buildAnthropicBody([user('x')], 0, false, undefined, {
      type: 'json_schema',
      json_schema: { name: 'only_name', schema: {} },
    }) as { tools: Array<{ description: string }> }
    expect(body.tools[0]!.description).toBe('only_name')
  })

  test('the synthesized tool is NOT marked cache_control', () => {
    // Pinned as MEASURED: the cache_control line lives on the plain-tools branch, so a
    // structured-output call sends an uncached tool block. Asserted so that if it is ever
    // unified, this test tells the reader the behaviour changed.
    const body = buildAnthropicBody([user('x')], 0, false, undefined, FORMAT) as {
      tools: Array<{ cache_control?: unknown }>
    }
    expect(body.tools[0]!.cache_control).toBeUndefined()
  })
})

describe('buildAnthropicBody — the streaming call site shape', () => {
  test('the streaming invocation (stream=true, no responseFormat) sets stream and passes tools', () => {
    // Mirrors llm-client.ts:215 exactly: buildAnthropicBody(messages, temperature, true, tools).
    const body = buildAnthropicBody([sys('s'), user('x')], 0, true, [
      { type: 'function', function: { name: 't', description: 'd', parameters: {} } },
    ]) as { stream: boolean; tools: unknown[]; tool_choice?: unknown }
    expect(body.stream).toBe(true)
    expect(body.tools).toHaveLength(1)
    expect('tool_choice' in body).toBe(false)
  })

  test('the non-streaming SQL call site shape (stream=false, responseFormat) forces the tool', () => {
    // Mirrors llm-client.ts:89.
    const body = buildAnthropicBody([sys('s'), user('x')], 0, false, undefined, {
      type: 'json_schema',
      json_schema: { name: 'n', description: 'd', schema: { type: 'object' } },
    }) as { stream?: boolean; tool_choice: unknown }
    expect('stream' in body).toBe(false)
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'n' })
  })
})
