/**
 * The plan MODEL: what a plan is, how a model's reply becomes one, and the rules that make it executable — the
 * dependency order, the per-step confirmation, the `{{stepN}}` substitution and how results are rendered for
 * synthesis. Pure functions, no I/O: `planner.ts` owns the LLM calls and the step execution, and re-exports
 * everything here so existing imports keep working.
 */
import { extractJson } from '@/lib/constrained-output'
import type { Citation } from '@/lib/types'
import type { ToolDef } from '@/lib/tool-registry'

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
  /** The step stopped on a question only the user can answer; `error` holds that question. */
  needsUserInput?: boolean
  /**
   * The step's own citations, CARRIED rather than dropped.
   *
   * MEASURED DEFECT: a compound question ("40 jam pelatihan AND total gaji") ran a RAG step and a SQL step, both
   * `success`, and the persisted assistant message carried `citations: []` — so the answer stated two figures from
   * two sources and the UI showed no source for either. `executeStep` built its result without this field, so the
   * citations `runNonStreamingChatCompletion` had just produced were discarded one frame later.
   */
  citations?: Citation[]
}

export type StepStatus = 'running' | 'done' | 'error'

export const MAX_STEPS = 6

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

export function normalizePlan(parsed: unknown): Plan {
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
  // ponytail: step ids are machine identifiers, never user-facing — lowercase them
  // (and dependsOn) so "Step1" vs "step1" from the LLM can't produce a dangling
  // dependency or a missed {{stepN}} substitution.
  const id = String(step.id ?? '').trim().toLowerCase()
  const tool = String(step.tool ?? '').trim()
  if (!id || !tool) return null
  const input =
    step.input && typeof step.input === 'object' && !Array.isArray(step.input)
      ? stringifyEntries(step.input as Record<string, unknown>)
      : {}
  const dependsOn = Array.isArray(step.dependsOn)
    ? step.dependsOn.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
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

/**
 * Restore the JSON type of each step input value before calling an MCP tool.
 *
 * The planner normalizes every step input to a STRING, but an MCP server's
 * JSON Schema declares real types (`tail: number`, `recursive: boolean`,
 * `paths: string[]`). Blindly `JSON.parse`-ing each value corrupts any string
 * that merely LOOKS like JSON — MEASURED: a legitimate `path: "12345"` became
 * the number `12345`, and `path: "\"quoted\""` lost its quotes. A server
 * validating its own schema then rejects the call, or worse, acts on a
 * different path than the model asked for.
 *
 * Fix: consult the tool's declared schema. Only convert when the JSON-parsed
 * value's TYPE MATCHES the declared type; otherwise keep the original string.
 * A string parameter can therefore never be silently retyped.
 */
export function coerceMcpInput(
  input: Record<string, string>,
  schema?: Record<string, unknown>,
): Record<string, unknown> {
  const declared = ((schema?.properties ?? {}) as Record<string, { type?: string }>)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input)) {
    const declaredType = declared[k]?.type
    // No declared schema for this key: keep the raw string. Passing a string to
    // a server that expected a number fails loudly and legibly; guessing risks
    // acting on the wrong value, which fails silently.
    if (!declaredType || declaredType === 'string') {
      out[k] = v
      continue
    }
    try {
      const parsed = JSON.parse(v)
      const matches =
        (declaredType === 'number' || declaredType === 'integer') && typeof parsed === 'number' ||
        declaredType === 'boolean' && typeof parsed === 'boolean' ||
        declaredType === 'array' && Array.isArray(parsed) ||
        declaredType === 'object' && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      // Type mismatch means the string was not a JSON literal of the declared
      // type (e.g. "5" for a number is fine; "abc" is not). Keep it as a string
      // and let the server report the validation error.
      out[k] = matches ? parsed : v
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

export function fallbackChatPlan(question = ''): Plan {
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

/**
 * Whether THIS step carries the user's confirmation.
 *
 * ponytail: was previously computed once per plan with `steps.some(...)`, which
 * meant confirming one step confirmed every step — a plan could smuggle an
 * unconfirmed admin action alongside a confirmed one. Per-step, always.
 */
export function isStepConfirmed(step: PlanStep): boolean {
  const { confirm, confirmed } = step.input
  return confirm === 'yes' || confirm === 'true' || confirmed === 'yes'
}

const MAX_INJECTED_OUTPUT = 8_000

/**
 * Replace {{stepN}} placeholders in a step's input values with that step's output.
 * A placeholder whose step failed or produced nothing resolves to empty string —
 * the tool then reports a missing input rather than receiving the literal "{{step1}}".
 *
 * ponytail: string substitution, not a template engine. Outputs are truncated so a
 * large fetched page can't blow the downstream tool's input budget.
 */
export function resolveStepInput(step: PlanStep, priorOutputs: Map<string, string>): PlanStep {
  if (priorOutputs.size === 0) return step
  let touched = false
  const input: Record<string, string> = {}
  for (const [key, value] of Object.entries(step.input)) {
    input[key] = value.replace(/\{\{\s*(step\d+)\s*\}\}/gi, (_match, id: string) => {
      touched = true
      return (priorOutputs.get(id.toLowerCase()) ?? '').slice(0, MAX_INJECTED_OUTPUT)
    })
  }
  return touched ? { ...step, input } : step
}

export function groupByLevel(sorted: PlanStep[]): PlanStep[][] {
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

/** Why a step failed. Every failure path sets output:'' and puts the reason in error. */
export function stepFailureReason(r: PlanStepResult): string {
  return r.error || r.output || 'unknown error'
}

/**
 * Render step results for a synthesis prompt.
 *
 * ponytail: failures MUST reach the model. Callers built this with
 * `r.output ?? r.error`, but a failed step carries output:'' — an empty string,
 * not nullish — so `??` kept the empty string and dropped the reason. The model
 * then saw a blank CONTEXT, had no tool result to report, and fell back to
 * pretrained knowledge: generic "clone the repo and run npm install" tutorials
 * instead of saying what actually broke.
 */
export function formatStepContext(results: PlanStepResult[]): string {
  return results
    .map((r) =>
      r.ok
        ? `[Step ${r.stepId} — ${r.tool}] OK\n${r.output}`
        : `[Step ${r.stepId} — ${r.tool}] FAILED: ${stepFailureReason(r)}`,
    )
    .join('\n\n---\n\n')
}

/**
 * Turn the tool calls the model made for a compound question into a plan, one independent step per call.
 *
 * The calls ARE the plan: asking a planner model to re-derive them costs a second LLM call and can come back
 * covering fewer parts than the model asked for, with nothing to compare against.
 */
export function planFromToolCalls(
  calls: Array<{ toolId: string; args: Record<string, unknown> }>,
  question: string,
): Plan {
  const steps = calls.slice(0, MAX_STEPS).map((call, i): PlanStep => {
    const input = stringifyEntries(call.args)
    const asked = (input.question ?? input.query ?? '').trim() || question
    // The step re-enters the router with only a question, so a database the model named travels in the text.
    const database = (input.database ?? '').trim()
    input.question = database && call.toolId === 'sql' ? `In ${database}: ${asked}` : asked
    return { id: `step${i + 1}`, tool: call.toolId, input }
  })
  return { steps, needsSynthesis: true }
}

/**
 * Append what a multi-part answer did NOT cover, deterministically.
 *
 * The synthesis model sees failed steps but is free to leave them out, and a dropped part is indistinguishable from
 * a complete answer. A part that stopped on a question for the user is asked; any other failed part is named with
 * its reason. When nothing succeeded and a part needs the user, the question is the whole reply.
 */
export function composePartialAnswer(answer: string, results: PlanStepResult[], plan: Plan): string {
  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) return answer
  const label = (r: PlanStepResult) => {
    const input = plan.steps.find((s) => s.id === r.stepId)?.input
    return (input?.question ?? input?.query ?? '').trim() || r.tool
  }
  const asks = failed.filter((r) => r.needsUserInput)
  const gaps = failed.filter((r) => !r.needsUserInput)
  // One line per part: a multi-paragraph reason would break out of the list.
  const line = (r: PlanStepResult) => `- ${label(r)}: ${stepFailureReason(r).replace(/\s+/g, ' ').trim()}`
  if (failed.length === results.length) {
    return asks.length > 0 && gaps.length === 0 ? asks.map(stepFailureReason).join('\n\n') : answer
  }
  const parts = [answer]
  if (gaps.length > 0) parts.push('**Not answered:**\n' + gaps.map(line).join('\n'))
  if (asks.length > 0) parts.push('**I need your input to answer the rest:**\n' + asks.map(line).join('\n'))
  return parts.join('\n\n')
}
