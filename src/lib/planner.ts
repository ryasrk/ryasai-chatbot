/**
 * Agentic planner — breaks a user question into a multi-step plan (DAG),
 * executes each step via the existing single-tool router, and synthesizes
 * a final answer from all step outputs.
 *
 * This closes G1 (router picks ONE tool) from the super-app roadmap.
 * The planner decides HOW MANY steps and in what order; each step still
 * uses `runNonStreamingChatCompletion` which routes to the right tool
 * (SQL/RAG/REST/CHAT) based on the sub-question text.
 */
import { generateAnswer, generateChat } from '@/lib/ai'
import { runNonStreamingChatCompletion } from '@/lib/tool-router'
import { recallContext } from '@/lib/cognee'
import { executePlugin } from '@/lib/plugin-registry'
import { callMcpTool } from '@/lib/mcp-client'
import { db } from '@/lib/db'
import { chatOnce as llmChatOnce, type LlmToolDef } from '@/lib/llm-client'
import { getLlmRuntimeConfig } from '@/lib/llm-config'
import type { ToolDef } from '@/lib/tool-registry'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanStep {
  id: string // 'step1', 'step2', etc
  tool: string // tool id from registry
  input: Record<string, string> // params for the tool
  dependsOn?: string[] // step ids that must complete first
}

export interface Plan {
  steps: PlanStep[]
  needsSynthesis: boolean // if true, run generateAnswer with all step outputs
}

export interface PlanStepResult {
  stepId: string
  tool: string
  ok: boolean
  output: string
  error?: string
  latencyMs: number
}

export type StepStatus = 'running' | 'done' | 'error'

const MAX_STEPS = 6

// ---------------------------------------------------------------------------
// Plan query — ask the LLM to produce a multi-step plan
// ---------------------------------------------------------------------------

const PLAN_STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string', description: 'Tool ID from the available tools list' },
    input: {
      type: 'object',
      description: 'Parameters for the tool',
      additionalProperties: true,
    },
    needsSynthesis: {
      type: 'boolean',
      description: 'Whether results need synthesis into a single answer',
    },
  },
  required: ['tool', 'input'],
}

// ponytail: native function calling is one-shot (single tool call), so this
// only produces single-step plans. Multi-step plans fall back to planQuery's
// manual JSON prompt. Add multi-step when providers support sequential calls.
export async function planQueryWithTools(args: {
  question: string
  availableTools: ToolDef[]
  sessionId?: string
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
}): Promise<Plan | null> {
  try {
    const cfg = await getLlmRuntimeConfig()
    if (!cfg) return null

    const toolList = args.availableTools
      .map((t) => `${t.id}: ${t.description}`)
      .join('\n')

    const memoryContext = await recallContext({
      query: args.question,
      sessionId: args.sessionId,
    })

    const historyText = args.chatHistory && args.chatHistory.length > 0
      ? args.chatHistory.slice(-10).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`).join('\n')
      : ''

    const systemPrompt =
      'You are an enterprise AI planner. Create a plan to answer the user\'s question. ' +
      `Select one tool from the available list. Maximum ${MAX_STEPS} steps. ` +
      'Call the execute_step function with the tool ID, input parameters, and whether synthesis is needed.'

    const userMessage =
      `Question: ${args.question}\n\n` +
      `Available tools:\n${toolList}\n\n` +
      (memoryContext ? `Memory from prior interactions:\n${memoryContext}\n\n` : '') +
      (historyText ? `Prior conversation history:\n${historyText}\n\n` : '') +
      `Plan the first step.`

    const tools: LlmToolDef[] = [
      {
        type: 'function',
        function: {
          name: 'execute_step',
          description: 'Execute one step of the plan using the specified tool',
          parameters: PLAN_STEP_SCHEMA,
        },
      },
    ]

    const result = await llmChatOnce(
      cfg,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      0,
      'planner',
      tools,
    )

    if (!Array.isArray(result) || result.length === 0) return null

    const stepData = JSON.parse(result[0].arguments) as {
      tool: string
      input?: Record<string, unknown>
      needsSynthesis?: boolean
    }

    const toolIds = new Set(args.availableTools.map((t) => t.id))
    if (!toolIds.has(stepData.tool)) return null

    const input: Record<string, string> = {}
    if (stepData.input && typeof stepData.input === 'object') {
      for (const [k, v] of Object.entries(stepData.input)) {
        input[k] = String(v)
      }
    }

    return {
      steps: [{ id: 'step1', tool: stepData.tool, input, dependsOn: [] }],
      needsSynthesis: stepData.needsSynthesis ?? false,
    }
  } catch {
    return null
  }
}

export async function planQuery(args: {
  question: string
  availableTools: ToolDef[]
  sessionId?: string
  chatHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
}): Promise<Plan> {
  const toolPlan = await planQueryWithTools(args)
  if (toolPlan) return toolPlan

  const toolList = args.availableTools
    .map((t) => `- ${t.id}: ${t.description} | params: ${t.paramDescription}`)
    .join('\n')

  const memoryContext = await recallContext({
    query: args.question,
    sessionId: args.sessionId,
  })

  const systemPrompt =
    'You are an enterprise AI planner. Create a multi-step plan to answer the user\'s question. ' +
    'Select tools from the available list. Each step may depend on a prior step via dependsOn. ' +
    `Maximum ${MAX_STEPS} steps. For simple questions, 1 step is enough. ` +
    'needsSynthesis=true if results from multiple steps need to be combined into one answer. ' +
    'needsSynthesis=false if one step is enough to answer. ' +
    'Answer ONLY with JSON without markdown code fence:\n' +
    '{"steps":[{"id":"step1","tool":"<tool_id>","input":{...},"dependsOn":[]}],"needsSynthesis":true|false}'

  const historyText = args.chatHistory && args.chatHistory.length > 0
    ? args.chatHistory.slice(-10).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`).join('\n')
    : ''

  const userMessage =
    `Question: ${args.question}\n\n` +
    `Available tools:\n${toolList}\n\n` +
    (memoryContext ? `Memory from prior interactions:\n${memoryContext}\n\n` : '') +
    (historyText ? `Prior conversation history:\n${historyText}\n\n` : '') +
    `Provide the JSON plan.`

  const raw = await generateChat(userMessage, systemPrompt)
  try {
    return parsePlanResponse(raw, args.availableTools)
  } catch {
    // Validation failed (bad tool, too many steps, cycle) — fail-closed to CHAT.
    return fallbackChatPlan(args.question)
  }
}

// ---------------------------------------------------------------------------
// Plan parsing + validation (pure functions, testable without LLM)
// ---------------------------------------------------------------------------

/**
 * Parse the LLM's raw JSON response into a validated Plan.
 * - Malformed JSON → fallback CHAT plan (no throw).
 * - Valid JSON but validation fails (bad tool, > MAX_STEPS, cycle) → throws.
 */
export function parsePlanResponse(raw: string, availableTools: ToolDef[]): Plan {
  const cleaned = stripCodeFences(raw).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return fallbackChatPlan()
  }
  const plan = normalizePlan(parsed)
  return validatePlan(plan, availableTools)
}

function stripCodeFences(raw: string): string {
  return raw.replace(/```json|```/g, '')
}

function normalizePlan(parsed: unknown): Plan {
  if (!parsed || typeof parsed !== 'object') return { steps: [], needsSynthesis: false }
  const obj = parsed as { steps?: unknown; needsSynthesis?: unknown }
  const steps = Array.isArray(obj.steps)
    ? obj.steps.map(normalizeStep).filter((s): s is PlanStep => s !== null)
    : []
  return {
    steps,
    needsSynthesis: obj.needsSynthesis === true,
  }
}

function normalizeStep(raw: unknown): PlanStep | null {
  if (!raw || typeof raw !== 'object') return null
  const step = raw as Record<string, unknown>
  const id = String(step.id ?? '').trim()
  const tool = String(step.tool ?? '').trim()
  if (!id || !tool) return null
  const input =
    step.input && typeof step.input === 'object' && !Array.isArray(step.input)
      ? stringifyEntries(step.input as Record<string, unknown>)
      : {}
  const dependsOn = Array.isArray(step.dependsOn)
    ? step.dependsOn.map(String).filter(Boolean)
    : undefined
  return { id, tool, input, dependsOn }
}

function stringifyEntries(record: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = String(value)
  }
  return result
}

// MCP tools expect typed JSON values (numbers, booleans, arrays) but the
// planner normalizes all step inputs to strings. Parse each value back to its
// JSON type where possible; leave as string when it isn't valid JSON.
function coerceMcpInput(input: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    try {
      out[k] = JSON.parse(v)
    } catch {
      out[k] = v
    }
  }
  return out
}

/**
 * Validate a plan against the available tools.
 * Throws on: empty plan, unknown tool, too many steps, circular deps, dangling dependsOn.
 */
export function validatePlan(plan: Plan, availableTools: ToolDef[]): Plan {
  if (plan.steps.length === 0) throw new PlanValidationError('Plan has no steps.')

  const toolIds = new Set(availableTools.map((t) => t.id))
  for (const step of plan.steps) {
    if (!toolIds.has(step.tool)) {
      throw new PlanValidationError(`Step ${step.id} uses unknown tool "${step.tool}".`)
    }
  }

  if (plan.steps.length > MAX_STEPS) {
    throw new PlanValidationError(`Plan has ${plan.steps.length} steps, max is ${MAX_STEPS}.`)
  }

  // topoSort throws on cycles and dangling dependsOn — re-throw as PlanValidationError.
  try {
    topoSort(plan.steps)
  } catch (e) {
    throw new PlanValidationError(
      e instanceof Error ? e.message : 'Plan dependency graph is invalid.',
    )
  }

  return plan
}

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanValidationError'
  }
}

function fallbackChatPlan(question = ''): Plan {
  return {
    steps: [
      {
        id: 'step1',
        tool: 'chat',
        input: { message: question || 'fallback' },
        dependsOn: [],
      },
    ],
    needsSynthesis: false,
  }
}

// ---------------------------------------------------------------------------
// Topological sort — Kahn's algorithm, preserves original order for ties
// ---------------------------------------------------------------------------

export function topoSort(steps: PlanStep[]): PlanStep[] {
  const stepMap = new Map(steps.map((s) => [s.id, s]))
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const step of steps) {
    inDegree.set(step.id, 0)
    dependents.set(step.id, [])
  }

  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!stepMap.has(dep)) {
        throw new Error(`Step "${step.id}" depends on unknown step "${dep}".`)
      }
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1)
      dependents.get(dep)!.push(step.id)
    }
  }

  // Start with all zero-indegree nodes in original order.
  const queue: string[] = steps
    .filter((s) => (inDegree.get(s.id) ?? 0) === 0)
    .map((s) => s.id)

  const result: PlanStep[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    result.push(stepMap.get(id)!)
    for (const dependent of dependents.get(id) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1
      inDegree.set(dependent, newDegree)
      if (newDegree === 0) queue.push(dependent)
    }
  }

  if (result.length !== steps.length) {
    throw new Error('Circular dependency detected in plan steps.')
  }

  return result
}

// ---------------------------------------------------------------------------
// Execute plan — run each step in topo order via the existing single-tool router
// ---------------------------------------------------------------------------

export async function executePlan(args: {
  plan: Plan
  userId: string
  sessionId?: string
  onStatus?: (stepId: string, tool: string, status: StepStatus) => void
}): Promise<PlanStepResult[]> {
  const results: PlanStepResult[] = []
  const sorted = topoSort(args.plan.steps)

  for (const step of sorted) {
    const started = Date.now()
    args.onStatus?.(step.id, step.tool, 'running')

    try {
      if (step.tool.startsWith('mcp:')) {
        // mcp:<serverId>:<toolName> — serverId is a cuid (no colons); toolName
        // may theoretically contain colons, so rejoin the remainder.
        const parts = step.tool.split(':')
        const serverId = parts[1]
        const toolName = parts.slice(2).join(':')
        const result = await callMcpTool(serverId, toolName, coerceMcpInput(step.input))
        results.push({
          stepId: step.id, tool: step.tool, ok: result.ok, output: result.output,
          error: result.error, latencyMs: Date.now() - started,
        })
        args.onStatus?.(step.id, step.tool, result.ok ? 'done' : 'error')
        continue
      }

      if (step.tool.startsWith('plugin:')) {
        const toolId = step.tool.slice('plugin:'.length)
        const plugin = await db.plugin.findFirst({
          where: { toolId, isEnabled: true, agenticEnabled: true },
        })
        if (!plugin) {
          results.push({
            stepId: step.id, tool: step.tool, ok: false, output: '',
            error: `Plugin ${step.tool} not found or inactive.`,
            latencyMs: Date.now() - started,
          })
          args.onStatus?.(step.id, step.tool, 'error')
          continue
        }
        const input = JSON.stringify(step.input)
        const result = await executePlugin({ plugin, input })
        results.push({
          stepId: step.id, tool: step.tool, ok: result.ok, output: result.output,
          error: result.error, latencyMs: result.latencyMs,
        })
        args.onStatus?.(step.id, step.tool, result.ok ? 'done' : 'error')
        continue
      }

      const question =
        step.input.question ?? step.input.query ?? step.input.message ?? step.input.input ?? ''
      const completion = await runNonStreamingChatCompletion({
        question,
        userId: args.userId,
      })
      const hasFailedTool = completion.toolRuns.some(
        (tr) => tr.status === 'error' || tr.status === 'blocked',
      )
      if (hasFailedTool) {
        const failedRun = completion.toolRuns.find(
          (tr) => tr.status === 'error' || tr.status === 'blocked',
        )
        results.push({
          stepId: step.id,
          tool: step.tool,
          ok: false,
          output: completion.answer,
          error: failedRun?.errorMessage ?? 'Tool execution failed',
          latencyMs: Date.now() - started,
        })
        args.onStatus?.(step.id, step.tool, 'error')
      } else {
        results.push({
          stepId: step.id,
          tool: step.tool,
          ok: true,
          output: completion.answer,
          latencyMs: Date.now() - started,
        })
        args.onStatus?.(step.id, step.tool, 'done')
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      // G10: self-correction — ask LLM to fix the input, retry once
      const corrected = await selfCorrect({
        step, error, userId: args.userId,
      })
      if (corrected) {
        results.push({
          stepId: step.id, tool: step.tool, ok: true, output: corrected,
          latencyMs: Date.now() - started,
        })
        args.onStatus?.(step.id, step.tool, 'done')
      } else {
        results.push({
          stepId: step.id,
          tool: step.tool,
          ok: false,
          output: '',
          error,
          latencyMs: Date.now() - started,
        })
        args.onStatus?.(step.id, step.tool, 'error')
      }
    }
  }

  return results
}

async function selfCorrect(args: {
  step: PlanStep
  error: string
  userId: string
}): Promise<string | null> {
  try {
    const originalQuestion =
      args.step.input.question ?? args.step.input.query ?? args.step.input.message ?? args.step.input.input ?? ''
    const fixedQuestion = await generateChat(
      `Original question: "${originalQuestion}" failed with error: "${args.error}". ` +
      `Reformulate the question to be more specific and answerable. Answer ONLY the reformulated question, without explanation.`,
    )
    if (!fixedQuestion.trim() || fixedQuestion.trim() === originalQuestion.trim()) return null
    const completion = await runNonStreamingChatCompletion({
      question: fixedQuestion.trim(),
      userId: args.userId,
    })
    return completion.answer
  } catch (e) {
    console.warn('[planner] selfCorrect failed:', e)
    return null
  }
}

// ---------------------------------------------------------------------------
// Synthesize — combine step outputs into a single NL answer
// ---------------------------------------------------------------------------

export async function synthesizeAnswer(args: {
  question: string
  stepResults: PlanStepResult[]
  plan: Plan
}): Promise<string> {
  const successful = args.stepResults.filter((r) => r.ok)

  if (successful.length === 0) {
    return 'Sorry, no steps completed successfully.'
  }

  const hasExternalToolStep = args.plan.steps.some(
    (s) => s.tool.startsWith('plugin:') || s.tool.startsWith('mcp:'),
  )

  if (!args.plan.needsSynthesis && successful.length === 1 && !hasExternalToolStep) {
    return successful[0].output
  }

  const context = successful
    .map((r) => `[Step ${r.stepId} — ${r.tool}]\n${r.output}`)
    .join('\n\n---\n\n')

  // ponytail: source label is cosmetic in the synthesis prompt; 'SQL' is the
  // most neutral generic label for multi-source context. Upgrade to per-step
  // source labels if synthesis quality needs it.
  return generateAnswer({
    question: args.question,
    context,
    source: 'SQL',
  })
}
