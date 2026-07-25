/**
 * Agent LLM client — thin wrappers over the unified transport (llm-client.ts).
 * Keeps agent-specific message building (AGENT_SYSTEM_PROMPT) and the
 * convenience signatures used by the agentic dashboard.
 */
import {
  chatOnce as llmChatOnce,
  chatStream as llmChatStream,
  getAgentConfig,
  type LlmMessage,
} from '@/lib/llm-client'

export interface AgentChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const AGENT_SYSTEM_PROMPT =
  'You are ryasai Agent — an internal AI assistant dedicated to system configuration and operations. ' +
  'You are NOT a user-facing chatbot. Your job: help admins manage system configuration, ' +
  'execute admin actions, check system status, and provide technical guidance. ' +
  'Answer clearly and technically. ' +
  'If the user asks for an action you cannot perform directly, explain the manual steps. ' +
  'You have access to: database integrations, documents, API keys, audit logs, ' +
  'routing scores, system prompt, tool toggles, plugins, schedules, monitoring metrics. ' +
  'When the user refers to prior conversation or data, use the conversation history to answer. ' +
  'Do not say data is unavailable if it was discussed in prior conversation history.'

export async function agentChatOnce(
  messages: AgentChatMessage[],
  temperature: number = 0,
): Promise<string> {
  const cfg = await getAgentConfig()
  if (!cfg) {
    throw new Error('Agent LLM belum dikonfigurasi. Set LLM config dengan purpose=agent di Settings.')
  }
  return llmChatOnce(cfg, messages as LlmMessage[], temperature)
}

export async function agentChat(
  question: string,
  context?: string,
): Promise<string> {
  const messages: AgentChatMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
  ]
  if (context) {
    messages.push({ role: 'system', content: `Konteks sistem:\n${context}` })
  }
  messages.push({ role: 'user', content: question })
  return agentChatOnce(messages)
}

export async function* agentChatStream(
  question: string,
  context?: string,
  chatHistory?: AgentChatMessage[],
): AsyncGenerator<string, void, unknown> {
  const cfg = await getAgentConfig()
  if (!cfg) {
    yield 'Agent LLM is not configured. Set LLM config with purpose=agent in Settings.'
    return
  }
  const messages: AgentChatMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
  ]
  if (context) {
    messages.push({ role: 'system', content: `System context:\n${context}` })
  }
  if (chatHistory && chatHistory.length > 0) {
    const historyText = chatHistory
      .slice(-10)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`)
      .join('\n')
    messages.push({ role: 'system', content: `Prior conversation history:\n${historyText}` })
  }
  messages.push({ role: 'user', content: question })
  yield* llmChatStream(cfg, messages as LlmMessage[], 0)
}
