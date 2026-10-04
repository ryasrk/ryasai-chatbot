/**
 * The completion primitives every `ai*.ts` generator shares: resolve the org's chat backend (fail-closed when none is
 * configured), one-shot and streaming completion at temperature 0 by default, and the bounded history window that
 * is re-sent with each turn. A leaf, so the generators split out of `ai.ts` can use it without importing `ai.ts`.
 */
import { getLlmRuntimeConfig, type LlmRuntimeConfig } from '@/lib/llm-config'
import { chatOnce as llmChatOnce, chatStream as llmChatStream, type LlmUsage } from '@/lib/llm-client'
import { LlmNotConfiguredError } from '@/lib/errors'
import { assertSystemMessagesUnderCeiling } from '@/lib/system-message-ceiling'

export type ChatRole = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: ChatRole
  content: string
}

export interface ChatOpts {
  temperature?: number
  purpose?: string
  /** Forwarded to chatStream so the caller can report token usage. */
  onUsage?: (usage: LlmUsage) => void
}

export async function resolveBackend(): Promise<{ cfg: LlmRuntimeConfig }> {
  const cfg = await getLlmRuntimeConfig()
  if (cfg && cfg.baseUrl && cfg.apiKey) return { cfg }
  throw new LlmNotConfiguredError()
}

/** Non-streaming completion. Returns the trimmed message content. */
export async function chatOnce(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const { cfg } = await resolveBackend()
  const temperature = opts.temperature ?? 0
  return llmChatOnce(cfg, messages, temperature, opts.purpose ?? 'chat')
}

/** Streaming completion — yields token chunks. */
export async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOpts = {},
): AsyncGenerator<string, void, unknown> {
  const { cfg } = await resolveBackend()
  const temperature = opts.temperature ?? 0
  yield* llmChatStream(cfg, messages, temperature, opts.purpose ?? 'chat', undefined, opts.onUsage)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * ponytail: history used to be flattened into ONE system message
 * ("Prior conversation history:\nUser: ... Assistant: ..."), which the model
 * reads as reference material, not as the live conversation — weaker
 * grounding for follow-ups ("itu", "yang tadi"). Native alternating
 * user/assistant turns keep the model's dialogue attention on the thread.
 * A short system note still labels the block so the model knows these are
 * prior turns, not the current question.
 *
 * MEASURED DEFECT in the first version of that note: it EMBEDDED the whole history a second
 * time (`Prior conversation history (most recent last):\n${formatHistory(recent)}`). Ten turns
 * of 2000 characters made the note 20,116 characters — and it is a `role:'system'` message, so
 * the provider DISCARDED it WHOLE (cliff ~2000, see `system-message-ceiling.ts`). The ordinary
 * case is over too: ten turns of 200 characters plus the 47-character prefix is 2047, so on any
 * realistic 10-turn conversation the label never arrived, while the same text was paid for twice
 * in the prompt. It is a SIGNPOST, so it now carries the signal without the copy — the turns
 * below already carry the content, and that is the mechanism the note describes.
 */
/**
 * The history window and the per-turn cap, named because they are a BUDGET, not incidental numbers.
 *
 * MEASURED (why 6 x 800 replaced 10 x 2000): the old window was up to 10 turns at 2,000 characters each — a
 * theoretical 20,000 characters (~5,500 tokens) of history re-sent on EVERY turn of a long conversation, on the
 * customer's BYOK key. Real turns are shorter than the cap, so the practical cost is lower, but the cap is what a
 * worst case costs and the worst case is reachable by pasting a log into the chat. 6 turns at 800 characters keeps
 * the three most recent exchanges intact (the "itu / yang tadi" follow-ups depend on the last few turns, not the
 * tenth) and bounds the worst case at 4,800 characters — a quarter of the old ceiling.
 *
 * Turns OLDER than the window are not lost: the send route injects the rolling session summary, which is built for
 * exactly this and covers topics and decisions from any depth.
 */
export const HISTORY_MAX_TURNS = 6

export const HISTORY_TURN_MAX_CHARS = 800

export function historyToMessages(history: ChatMessage[]): ChatMessage[] {
  const recent = history.slice(-HISTORY_MAX_TURNS)
  const out: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Prior conversation history (most recent last): the turns that follow are shared context, ' +
        'not the current question. Answer the NEW question at the end.',
    },
  ]
  for (const m of recent) {
    if (!m.content || !m.content.trim()) continue
    out.push({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content.slice(0, HISTORY_TURN_MAX_CHARS),
    })
  }
  // Guarded here rather than only at each caller: this produces the history block for
  // generateAnswer / generateChat / streamAnswer / streamChat, so a note that grows again fails
  // once, at the source, instead of in whichever call site happens to be exercised.
  assertSystemMessagesUnderCeiling(out, 'historyToMessages')
  return out
}
