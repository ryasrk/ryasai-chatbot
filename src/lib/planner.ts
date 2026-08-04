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
import { checkToolRateLimit } from '@/lib/tool-rate-limit'
import { getOrgContext } from '@/lib/prisma-tenant'
import { executeAdminTool } from '@/lib/admin-tools'
import { fetchUrlForPlanner } from '@/lib/web-fetch'
import { db } from '@/lib/db'
import { chatOnce as llmChatOnce, type LlmToolDef } from '@/lib/llm-client'
import { getLlmRuntimeConfig } from '@/lib/llm-config'
import { extractJson } from '@/lib/constrained-output'
import { withToolSandbox } from '@/lib/tool-sandbox'
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
      'Call the execute_step function with the tool ID, input parameters, and whether synthesis is needed. ' +
      'CONFIRMATION FLOW: Some tools (admin:mcp_install, admin:mcp_remove, admin:set_prompt, admin:toggle_*) ' +
      'require confirmation. On the first call, do NOT include confirm in the input — the tool will ask the user to confirm. ' +
      'When the user confirms (says "yes", "confirm", "go ahead"), re-call the same tool with the same input plus "confirm":"yes". ' +
      'MCP INSTALL FROM URL: Use a two-step plan — (1) web_fetch the URL to read install instructions, (2) admin:mcp_install with the extracted command/args/envVars.'

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
      'IMPORTANT RULES:\n' +
      '- If the user asks to search the web, look up information, find a person/topic, or get news, use the plugin:web_search tool — NEVER use chat for these.\n' +
      '- If the user asks to read/fetch a specific article or URL, use plugin:url_fetch.\n' +
      '- If the user asks to translate text, use plugin:translate.\n' +
      '- If the user asks for weather, use plugin:weather.\n' +
      '- If the user asks for calculations, use plugin:calculator.\n' +
      '- Only use the chat tool for greetings, opinions, or questions that truly need no external data.\n' +
      '- Only use sql if the question is about structured data in connected databases (sales, inventory, customers).\n' +
      '- Only use rag if the question is about company documents (SOPs, policies, guidelines).\n' +
      '- To install/add/set up an MCP server from a URL, use a TWO-STEP plan: (1) web_fetch the URL to read the installation instructions, (2) admin:mcp_install with the server name, URL, and the command/args/envVars you extracted from the fetched content.\n' +
      '- To install a known MCP server by name (filesystem, github, postgres, etc.), use admin:mcp_install directly with the name.\n' +
      '- To set credentials for an MCP server, use admin:mcp_set_credentials with the server name and credentials.\n' +
      '- To list MCP servers, use admin:mcp_list.\n' +
      '- To test an MCP server, use admin:mcp_test.\n' +
      '- To remove an MCP server, use admin:mcp_remove.\n' +
      '- To seed/restore prebuilt plugins, use admin:seed_plugins.\n' +
      '- Use web_fetch to read any URL (GitHub repo, docs page, blog post) and get its text content. Useful for reading installation instructions before installing an MCP server.\n' +
      'CONFIRMATION FLOW: Tools marked "REQUIRES user confirmation" need a two-turn flow. On the first call, do NOT include confirm in the input. The tool will return a confirmation message — relay it to the user. When the user confirms (says "yes", "confirm", "go ahead"), re-call the same tool with the same input plus "confirm":"yes".\n' +
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
  let parsed: unknown
  try {
    parsed = extractJson(raw)
  } catch {
    return fallbackChatPlan()
  }
  const plan = normalizePlan(parsed)
  return validatePlan(plan, availableTools)
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
    } catch (e) {
      console.warn(`[planner] coerceMcpInput: failed to parse key "${k}" as JSON, using string:`, e)
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
  isAdmin?: boolean
}): Promise<PlanStepResult[]> {
  const results: PlanStepResult[] = []
  const sorted = topoSort(args.plan.steps)

  // ponytail: check if the user confirmed — planner passes this via the message context
  const isConfirmed = args.plan.steps.some((s) =>
    s.input.confirm === 'yes' || s.input.confirmed === 'yes' || s.input.confirm === 'true',
  )

  // ponytail: group steps by dependency level. Steps at the same level have
  // no dependencies on each other and can execute in parallel. Steps at level N
  // depend only on steps at level < N. Ceiling: O(levels) sequential rounds,
  // each round parallel within. For 6-step plans with 3 independent pairs,
  // this saves ~50% vs fully sequential.
  const levels = groupByLevel(sorted)

  for (const level of levels) {
    const levelResults = await Promise.all(
      level.map((step) =>
        withToolSandbox(step.tool, () => executeStep(step, args, isConfirmed)).catch((e) => {
          args.onStatus?.(step.id, step.tool, 'error')
          return {
            stepId: step.id, tool: step.tool, ok: false, output: '',
            error: e instanceof Error ? e.message : String(e), latencyMs: 0,
          } as PlanStepResult
        }),
      ),
    )
    results.push(...levelResults)
  }

  return results
}

function groupByLevel(sorted: PlanStep[]): PlanStep[][] {
  const levels: PlanStep[][] = []
  const completedIds = new Set<string>()

  while (completedIds.size < sorted.length) {
    const currentLevel = sorted.filter((step) => {
      if (completedIds.has(step.id)) return false
      const deps = step.dependsOn ?? []
      return deps.every((dep) => completedIds.has(dep))
    })

    if (currentLevel.length === 0) break

    levels.push(currentLevel)
    for (const step of currentLevel) {
      completedIds.add(step.id)
    }
  }

  return levels
}

async function executeStep(
  step: PlanStep,
  args: { userId: string; sessionId?: string; onStatus?: (stepId: string, tool: string, status: StepStatus) => void; isAdmin?: boolean },
  isConfirmed: boolean,
): Promise<PlanStepResult> {
  const started = Date.now()
  args.onStatus?.(step.id, step.tool, 'running')

  try {
    // Admin tools — platform management (generate API key, show monitoring, etc.)
    if (step.tool.startsWith('admin:')) {
      // Defense-in-depth: never execute admin.* unless the caller is an admin.
      // Even if a plan leaks an admin:* step (prompt injection), this blocks it.
      if (!args.isAdmin) {
        args.onStatus?.(step.id, step.tool, 'error')
        return {
          stepId: step.id, tool: step.tool, ok: false, output: '',
          error: 'Admin tool requires an administrator account.', latencyMs: Date.now() - started,
        }
      }
      const result = await executeAdminTool(step.tool, step.input, args.userId, isConfirmed)
      if (result.confirmationRequired) {
        // ponytail: confirmationRequired is NOT an error — it's a gate. Pass the
        // confirmation message through as output so the LLM synthesizer relays it
        // to the user. Mark as 'done' so the UI doesn't show "Failed".
        // When the user confirms in a follow-up, the planner will re-call this
        // tool with confirm:"yes" in the input, and isConfirmed will be true.
        args.onStatus?.(step.id, step.tool, 'done')
        return {
          stepId: step.id, tool: step.tool, ok: true, output: result.confirmationRequired.message,
          latencyMs: Date.now() - started,
        }
      }
      args.onStatus?.(step.id, step.tool, result.ok ? 'done' : 'error')
      return {
        stepId: step.id, tool: step.tool, ok: result.ok, output: result.output,
        error: result.ok ? undefined : result.output, latencyMs: Date.now() - started,
      }
    }

    if (step.tool.startsWith('mcp:')) {
      // mcp:<serverId>:<toolName> — serverId is a cuid (no colons); toolName
      // may theoretically contain colons, so rejoin the remainder.
      const parts = step.tool.split(':')
      const serverId = parts[1]
      const toolName = parts.slice(2).join(':')
      // Per-org rate limit on MCP tool invocations.
      const orgId = getOrgContext()
      if (orgId) {
        const rl = await checkToolRateLimit('mcp', orgId)
        if (!rl.allowed) {
          args.onStatus?.(step.id, step.tool, 'error')
          return {
            stepId: step.id, tool: step.tool, ok: false, output: '',
            error: 'Rate limit exceeded for MCP tools. Try again in a minute.',
            latencyMs: Date.now() - started,
          }
        }
      }
      const result = await callMcpTool(serverId, toolName, coerceMcpInput(step.input))
      args.onStatus?.(step.id, step.tool, result.ok ? 'done' : 'error')
      // ponytail: persist a ToolRun row at invocation time for MCP observability.
      // chatMessageId is null here — the planner runs before the AI message is
      // persisted. runMultiStepDag filters MCP steps from its returned toolRuns
      // so callers don't create duplicate rows.
      if (orgId) {
        await db.toolRun.create({
          data: {
            organizationId: orgId,
            chatMessageId: null,
            type: 'PLUGIN',
            status: result.ok ? 'success' : 'error',
            latencyMs: Date.now() - started,
            inputSummary: `MCP: ${toolName}`,
            outputSummary: result.output.slice(0, 500) || null,
            errorMessage: result.error ?? null,
          },
        }).catch(() => {})
      }
      return {
        stepId: step.id, tool: step.tool, ok: result.ok, output: result.output,
        error: result.error, latencyMs: Date.now() - started,
      }
    }

    // web_fetch — fetch any URL and return readable text content.
    // Used by the planner to read installation instructions, docs, etc.
    if (step.tool === 'web_fetch') {
      const url = (step.input.url || step.input.link || '').trim()
      if (!url) {
        args.onStatus?.(step.id, step.tool, 'error')
        return {
          stepId: step.id, tool: step.tool, ok: false, output: '',
          error: 'URL is required for web_fetch.', latencyMs: Date.now() - started,
        }
      }
      const result = await fetchUrlForPlanner(url)
      args.onStatus?.(step.id, step.tool, result.ok ? 'done' : 'error')
      return {
        stepId: step.id, tool: step.tool, ok: result.ok,
        output: result.ok ? result.content : '',
        error: result.ok ? undefined : result.error,
        latencyMs: Date.now() - started,
      }
    }

    if (step.tool.startsWith('plugin:')) {
      const toolId = step.tool.slice('plugin:'.length)
      // ponytail: context filtering already happened in getAvailableTools when
      // building the tool list offered to the planner. Here we only check
      // isEnabled — the chat/agentic flag was already enforced upstream.
      const plugin = await db.plugin.findFirst({
        where: { toolId, isEnabled: true },
      })
      if (!plugin) {
        args.onStatus?.(step.id, step.tool, 'error')
        return {
          stepId: step.id, tool: step.tool, ok: false, output: '',
          error: `Plugin ${step.tool} not found or inactive.`,
          latencyMs: Date.now() - started,
        }
      }
      const input = JSON.stringify(step.input)
      const result = await executePlugin({ plugin, input })
      args.onStatus?.(step.id, step.tool, result.ok ? 'done' : 'error')
      return {
        stepId: step.id, tool: step.tool, ok: result.ok, output: result.output,
        error: result.error, latencyMs: result.latencyMs,
      }
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
      args.onStatus?.(step.id, step.tool, 'error')
      return {
        stepId: step.id,
        tool: step.tool,
        ok: false,
        output: completion.answer,
        error: failedRun?.errorMessage ?? 'Tool execution failed',
        latencyMs: Date.now() - started,
      }
    }
    args.onStatus?.(step.id, step.tool, 'done')
    return {
      stepId: step.id,
      tool: step.tool,
      ok: true,
      output: completion.answer,
      latencyMs: Date.now() - started,
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    // G10: self-correction — ask LLM to fix the input, retry once
    const corrected = await selfCorrect({
      step, error, userId: args.userId,
    })
    if (corrected) {
      args.onStatus?.(step.id, step.tool, 'done')
      return {
        stepId: step.id, tool: step.tool, ok: true, output: corrected,
        latencyMs: Date.now() - started,
      }
    }
    args.onStatus?.(step.id, step.tool, 'error')
    return {
      stepId: step.id,
      tool: step.tool,
      ok: false,
      output: '',
      error,
      latencyMs: Date.now() - started,
    }
  }
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
