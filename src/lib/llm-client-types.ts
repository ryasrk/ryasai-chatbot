/**
 * LLM client — shared types and interfaces.
 * Leaf module: no deps on other llm-client split files.
 */
export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

export interface LlmImageContent {
  type: 'image_url'
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export interface LlmTextContent {
  type: 'text'
  text: string
}

export type LlmContentPart = LlmTextContent | LlmImageContent

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LlmContentPart[] | null
  tool_calls?: LlmToolCall[]
  tool_call_id?: string
  name?: string
}

export interface LlmToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
    allowed_callers?: Array<'direct' | 'programmatic'>
    output_schema?: Record<string, unknown>
    strict?: boolean
  }
}

export interface LlmToolResult {
  id: string
  name: string
  result: string
  isError?: boolean
}

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface LlmResponseFormat {
  type: 'json_schema'
  json_schema: {
    name: string
    description?: string
    schema: Record<string, unknown>
    strict?: boolean
  }
}

export interface LlmMultiAgentOptions {
  enabled: boolean
  maxConcurrentSubagents?: number
}

export interface LlmMultiAgentCall {
  type: string
  agentName?: string
  taskMessage?: string
}

export interface LlmResponsesOptions {
  temperature?: number
  purpose?: string
  tools?: LlmToolDef[]
  responseFormat?: LlmResponseFormat
  previousResponseId?: string
  background?: boolean
  multiAgent?: LlmMultiAgentOptions
  programmaticToolCalling?: boolean
}

export interface LlmResponsesResult {
  text: string
  responseId: string
  usage?: LlmUsage
  toolCalls?: LlmToolCall[]
  multiAgentCalls?: LlmMultiAgentCall[]
  programOutput?: string
}

export interface AgentChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
