import { test, expect, describe } from 'bun:test'
import { topoSort, parsePlanResponse, validatePlan, PlanValidationError } from '@/lib/planner'
import type { PlanStep, Plan } from '@/lib/planner'
import type { ToolDef } from '@/lib/tool-registry'

const TOOLS: ToolDef[] = [
  { id: 'sql', description: 'Query DB', paramDescription: '{}', requiresDataSource: 'integration' },
  { id: 'rag', description: 'Search docs', paramDescription: '{}', requiresDataSource: 'document' },
  { id: 'chat', description: 'General chat', paramDescription: '{}', requiresDataSource: 'none' },
]

describe('topoSort', () => {
  test('linear deps → correct order', () => {
    const steps: PlanStep[] = [
      { id: 'c', tool: 'chat', input: {}, dependsOn: ['b'] },
      { id: 'b', tool: 'chat', input: {}, dependsOn: ['a'] },
      { id: 'a', tool: 'chat', input: {} },
    ]
    const sorted = topoSort(steps).map((s) => s.id)
    expect(sorted).toEqual(['a', 'b', 'c'])
  })

  test('circular deps → throws', () => {
    const steps: PlanStep[] = [
      { id: 'a', tool: 'chat', input: {}, dependsOn: ['b'] },
      { id: 'b', tool: 'chat', input: {}, dependsOn: ['a'] },
    ]
    expect(() => topoSort(steps)).toThrow()
  })

  test('no deps → original order preserved', () => {
    const steps: PlanStep[] = [
      { id: 'x', tool: 'chat', input: {} },
      { id: 'y', tool: 'sql', input: {} },
    ]
    expect(topoSort(steps).map((s) => s.id)).toEqual(['x', 'y'])
  })

  test('dangling dependsOn → throws', () => {
    const steps: PlanStep[] = [
      { id: 'a', tool: 'chat', input: {}, dependsOn: ['nonexistent'] },
    ]
    expect(() => topoSort(steps)).toThrow()
  })
})

describe('parsePlanResponse', () => {
  test('valid single-step plan', () => {
    const raw = JSON.stringify({
      steps: [{ id: 'step1', tool: 'chat', input: { message: 'hello' } }],
      needsSynthesis: false,
    })
    const plan = parsePlanResponse(raw, TOOLS)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].tool).toBe('chat')
    expect(plan.needsSynthesis).toBe(false)
  })

  test('valid multi-step plan with deps', () => {
    const raw = JSON.stringify({
      steps: [
        { id: 'step1', tool: 'sql', input: { question: 'sales data' } },
        { id: 'step2', tool: 'rag', input: { query: 'return policy' }, dependsOn: ['step1'] },
      ],
      needsSynthesis: true,
    })
    const plan = parsePlanResponse(raw, TOOLS)
    expect(plan.steps).toHaveLength(2)
    expect(plan.needsSynthesis).toBe(true)
  })

  test('malformed JSON → fallback CHAT plan', () => {
    const plan = parsePlanResponse('not json at all', TOOLS)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].tool).toBe('chat')
  })

  test('code-fenced JSON → parsed correctly', () => {
    const raw = '```json\n{"steps":[{"id":"s1","tool":"chat","input":{}}],"needsSynthesis":false}\n```'
    const plan = parsePlanResponse(raw, TOOLS)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].id).toBe('s1')
  })
})

describe('validatePlan', () => {
  test('tool not in registry → throws', () => {
    const plan: Plan = {
      steps: [{ id: 's1', tool: 'nonexistent', input: {} }],
      needsSynthesis: false,
    }
    expect(() => validatePlan(plan, TOOLS)).toThrow(PlanValidationError)
  })

  test('empty steps → throws', () => {
    const plan: Plan = { steps: [], needsSynthesis: false }
    expect(() => validatePlan(plan, TOOLS)).toThrow(PlanValidationError)
  })
})
