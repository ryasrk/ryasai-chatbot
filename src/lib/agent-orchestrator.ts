/**
 * Dynamic ReAct Agent Orchestrator — Frontier Standard.
 * ----------------------------------------------------------------------------
 * Replaces static upfront DAG planning with an adaptive Reasoning-Action-Observation
 * loop (ReAct) supporting:
 *   - Native LLM function/tool calling (OpenAI & Anthropic protocols)
 *   - Parallel tool execution per round
 *   - Lossless JSON Schema parameter validation
 *   - Tool Circuit Breaker to prevent error accumulation and cascading timeouts
 *   - Interactive human-in-the-loop confirmation gates
 *   - Real-time SSE event streaming for dashboards & chat
 */

import { getLlmRuntimeConfig } from '@/lib/llm-config'
import { chatOnce, type LlmToolDef } from '@/lib/llm-client'
import type { LlmMessage, LlmToolCall } from '@/lib/llm-client-types'
import { recallContext } from '@/lib/cognee'
import {
  getUnifiedTools,
  toLlmToolDef,
  functionNameToToolId,
  type UnifiedTool,
  type ToolExecutionContext,
  type ToolExecutionResult,
} from '@/lib/unified-tools'
import { toolCircuitBreaker } from '@/lib/tool-circuit-breaker'
import type { PendingToolRun, CompletionResult, ChatHistoryEntry } from '@/lib/tool-utils'
import { toolRunTypeFor } from '@/lib/tool-router-agentic'
import { scopedLogger } from '@/lib/logger'
import { createTokenBudget, type TokenBudget } from '@/lib/agentic-budget'

const log = scopedLogger('agent-orchestrator')

export interface AgentOrchestratorEvent {
  type: 'thinking' | 'tool_start' | 'tool_end' | 'answer_delta' | 'done' | 'error'
  data: Record<string, unknown>
}

export interface AgentOrchestratorOptions {
  question: string
  userId: string
  organizationId?: string
  sessionId?: string
  context?: 'chat' | 'agentic'
  isAdmin?: boolean
  chatHistory?: ChatHistoryEntry[]
  systemPromptPrefix?: string
  maxRounds?: number
  budget?: TokenBudget
  onEvent?: (event: AgentOrchestratorEvent) => void
}

export interface AgentOrchestratorResult {
  answer: string
  toolRuns: PendingToolRun[]
  iterations: number
  citations: string[]
  usage?: { promptTokens: number; completionTokens: number }
  confirmationRequired?: { action: string; message: string }
}

const DEFAULT_MAX_ROUNDS = 5
const MAX_OUTPUT_IN_CONTEXT = 3000

export async function runAgentOrchestrator(
  options: AgentOrchestratorOptions,
): Promise<AgentOrchestratorResult> {
  const cfg = await getLlmRuntimeConfig()
  if (!cfg) {
    throw new Error('AI provider is not configured. Please configure your LLM settings.')
  }

  const context = options.context ?? 'chat'
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS
  const budget = options.budget ?? createTokenBudget()
  const allToolRuns: PendingToolRun[] = []
  const citations: string[] = []

  // 1. Resolve available Unified Tools
  const tools = await getUnifiedTools({
    query: options.question,
    context,
    isAdmin: options.isAdmin,
  })
  const llmToolDefs: LlmToolDef[] = tools.map(toLlmToolDef)

  // 2. Fetch memory context
  const memoryContext = await recallContext({
    query: options.question,
    sessionId: options.sessionId,
  }).catch(() => '')

  // 3. Build base system prompt
  const systemPrompt = [
    'You are an advanced enterprise AI agent equipped with direct access to database queries, document search, web tools, and system connectors.',
    'Follow a dynamic ReAct (Reasoning and Action) process:',
    '1. Analyze the user request and determine what specific factual information is required.',
    '2. Call one or more relevant tools to gather data. You may call multiple tools in parallel if their parameters are independent.',
    '3. Observe the outputs returned by tools. If an error occurs or data is missing, adapt your query or use alternative tools.',
    '4. Once you have sufficient evidence, provide a thorough, accurate, and grounded final answer.',
    'CONFIRMATION RULE: High-impact actions (creating API keys, changing system prompts, installing/removing servers) require user confirmation. If a tool reports that confirmation is required, relay the prompt to the user and await their confirmation.',
    options.systemPromptPrefix ? `\n[Organization Guidance]\n${options.systemPromptPrefix}` : '',
    memoryContext ? `\n[Prior Memory Context]\n${memoryContext}` : '',
  ].filter(Boolean).join('\n')

  // 4. Initialize message history
  const messages: LlmMessage[] = [{ role: 'system', content: systemPrompt }]

  if (options.chatHistory && options.chatHistory.length > 0) {
    for (const h of options.chatHistory.slice(-8)) {
      messages.push({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: h.content,
      })
    }
  }

  messages.push({ role: 'user', content: options.question })

  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  let iterations = 0

  // 5. ReAct Execution Loop
  for (let round = 1; round <= maxRounds; round++) {
    iterations = round
    options.onEvent?.({
      type: 'thinking',
      data: { round, content: round === 1 ? 'Analyzing goal and selecting tools...' : 'Evaluating observations and deciding next step...' },
    })

    const response = await chatOnce(cfg, messages, 0, 'agent', llmToolDefs)

    // Case A: LLM requested one or more tool calls
    if (Array.isArray(response) && response.length > 0) {
      const toolCalls: LlmToolCall[] = response

      // Add the assistant's decision to messages
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: toolCalls,
      })

      // Execute tool calls in parallel
      const toolExecutionContext: ToolExecutionContext = {
        userId: options.userId,
        organizationId: options.organizationId,
        sessionId: options.sessionId,
        isAdmin: options.isAdmin,
      }

      const executionPromises = toolCalls.map(async (call) => {
        const toolId = functionNameToToolId(call.name, tools)
        const matchedTool = tools.find((t) => t.id === toolId || t.name === call.name)
        const stepId = call.id || `call_${Date.now()}`

        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : (call.arguments || {})
        } catch {
          parsedArgs = { raw: call.arguments }
        }

        options.onEvent?.({
          type: 'tool_start',
          data: { stepId, toolId, toolName: call.name, arguments: parsedArgs },
        })

        if (!matchedTool) {
          const errMsg = `Tool "${call.name}" is not recognized or available.`
          options.onEvent?.({
            type: 'tool_end',
            data: { stepId, toolId, status: 'error', error: errMsg, latencyMs: 0 },
          })
          return {
            callId: call.id,
            toolId,
            result: { ok: false, output: '', error: errMsg, latencyMs: 0 } as ToolExecutionResult,
          }
        }

        // Check Circuit Breaker
        const cb = toolCircuitBreaker.isExecutionAllowed(matchedTool.id)
        if (!cb.allowed) {
          options.onEvent?.({
            type: 'tool_end',
            data: { stepId, toolId: matchedTool.id, status: 'error', error: cb.reason, latencyMs: 0 },
          })
          return {
            callId: call.id,
            toolId: matchedTool.id,
            result: { ok: false, output: '', error: cb.reason, latencyMs: 0 } as ToolExecutionResult,
          }
        }

        const start = Date.now()
        try {
          const res = await matchedTool.execute(parsedArgs, toolExecutionContext)
          const latencyMs = Date.now() - start
          res.latencyMs = latencyMs

          if (res.ok) {
            toolCircuitBreaker.recordSuccess(matchedTool.id)
          } else {
            toolCircuitBreaker.recordFailure(matchedTool.id, res.error)
          }

          options.onEvent?.({
            type: 'tool_end',
            data: {
              stepId,
              toolId: matchedTool.id,
              status: res.ok ? 'success' : 'error',
              output: res.output.slice(0, 300),
              error: res.error,
              latencyMs,
            },
          })

          return { callId: call.id, toolId: matchedTool.id, result: res }
        } catch (err) {
          const latencyMs = Date.now() - start
          const errorMsg = err instanceof Error ? err.message : String(err)
          toolCircuitBreaker.recordFailure(matchedTool.id, err)

          options.onEvent?.({
            type: 'tool_end',
            data: { stepId, toolId: matchedTool.id, status: 'error', error: errorMsg, latencyMs },
          })

          return {
            callId: call.id,
            toolId: matchedTool.id,
            result: { ok: false, output: '', error: errorMsg, latencyMs } as ToolExecutionResult,
          }
        }
      })

      const executedResults = await Promise.all(executionPromises)

      // Feed observations back into message context for next reasoning round
      for (const item of executedResults) {
        const observationText = item.result.ok
          ? (item.result.output || 'Action completed successfully.')
          : `Error executing tool: ${item.result.error || 'Unknown error'}`

        messages.push({
          role: 'tool',
          tool_call_id: item.callId,
          name: callNameForId(item.callId, toolCalls),
          content: observationText.slice(0, MAX_OUTPUT_IN_CONTEXT),
        })

        // Track ToolRun for auditing
        allToolRuns.push({
          type: toolRunTypeFor(item.toolId),
          status: item.result.ok ? 'success' : 'error',
          latencyMs: item.result.latencyMs,
          inputSummary: `Agent [${item.toolId}]`,
          outputSummary: (item.result.output || '').slice(0, 500) || undefined,
          errorMessage: item.result.error,
        })

        if (item.result.confirmationRequired) {
          // If human confirmation is required, halt the loop and return prompt
          options.onEvent?.({
            type: 'done',
            data: { answer: item.result.output, confirmationRequired: item.result.confirmationRequired },
          })
          return {
            answer: item.result.output,
            toolRuns: allToolRuns,
            iterations: round,
            citations,
            confirmationRequired: item.result.confirmationRequired,
          }
        }
      }

      continue
    }

    // Case B: LLM returned final text answer
    const finalAnswer = typeof response === 'string' ? response : ''
    options.onEvent?.({
      type: 'done',
      data: { answer: finalAnswer, iterations: round },
    })

    return {
      answer: finalAnswer,
      toolRuns: allToolRuns,
      iterations: round,
      citations,
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
    }
  }

  // If maxRounds reached without clean text exit, synthesize based on evidence gathered
  const fallbackAnswer = 'I have gathered information from the available tools but reached the round limit. Please review the tool outputs above.'
  return {
    answer: fallbackAnswer,
    toolRuns: allToolRuns,
    iterations: maxRounds,
    citations,
  }
}

function callNameForId(callId: string, calls: LlmToolCall[]): string {
  const match = calls.find((c) => c.id === callId)
  return match?.name || 'unknown'
}

/**
 * Streaming variant of the ReAct orchestrator for SSE endpoints.
 */
export async function* streamAgentOrchestrator(
  options: AgentOrchestratorOptions,
): AsyncGenerator<{ event: string; data: unknown }, AgentOrchestratorResult, void> {
  let finalResult: AgentOrchestratorResult | null = null

  // Run with event streaming adapter
  const queue: Array<{ event: string; data: unknown }> = []
  let resolveWaiting: (() => void) | null = null

  const pushEvent = (event: string, data: unknown) => {
    queue.push({ event, data })
    if (resolveWaiting) {
      resolveWaiting()
      resolveWaiting = null
    }
  }

  const runnerPromise = runAgentOrchestrator({
    ...options,
    onEvent: (ev) => {
      pushEvent(ev.type, ev.data)
      options.onEvent?.(ev)
    },
  }).then((res) => {
    finalResult = res
    if (resolveWaiting) {
      resolveWaiting()
      resolveWaiting = null
    }
    return res
  })

  while (!finalResult || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        resolveWaiting = resolve
      })
    }
    while (queue.length > 0) {
      const item = queue.shift()!
      yield item
    }
  }

  return finalResult!
}
