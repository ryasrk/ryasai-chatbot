import { describe, expect, test } from 'bun:test'
import { planToMermaid, planToMermaidGrouped } from './dag-preview'
import type { Plan } from '@/lib/planner'

const linearPlan: Plan = {
  steps: [
    { id: 'step1', tool: 'sql', input: { question: 'count users' } },
    { id: 'step2', tool: 'rag', input: { question: 'policy on leave' }, dependsOn: ['step1'] },
    { id: 'step3', tool: 'chat', input: { question: 'summarize' }, dependsOn: ['step2'] },
  ],
  needsSynthesis: true,
}

const parallelPlan: Plan = {
  steps: [
    { id: 's1', tool: 'sql', input: { question: 'revenue' } },
    { id: 's2', tool: 'rag', input: { question: 'leave policy' } },
    { id: 's3', tool: 'chat', input: { question: 'combine' }, dependsOn: ['s1', 's2'] },
  ],
  needsSynthesis: true,
}

const emptyPlan: Plan = { steps: [], needsSynthesis: false }

describe('planToMermaid', () => {
  test('starts with flowchart TD directive', () => {
    const out = planToMermaid(linearPlan)
    expect(out.startsWith('flowchart TD')).toBe(true)
  })

  test('emits a node per step', () => {
    const out = planToMermaid(linearPlan)
    expect(out).toContain('step1')
    expect(out).toContain('step2')
    expect(out).toContain('step3')
  })

  test('emits dependency edges', () => {
    const out = planToMermaid(linearPlan)
    expect(out).toContain('step1 --> step2')
    expect(out).toContain('step2 --> step3')
  })

  test('emits style per step based on tool type', () => {
    const out = planToMermaid(linearPlan)
    expect(out).toContain('style step1 fill:#dbeafe')
    expect(out).toContain('style step2 fill:#dcfce7')
    expect(out).toContain('style step3 fill:#f3e8ff')
  })

  test('parallel plan has multiple deps into one node', () => {
    const out = planToMermaid(parallelPlan)
    expect(out).toContain('s1 --> s3')
    expect(out).toContain('s2 --> s3')
  })

  test('no deps → no edge lines', () => {
    const noDeps: Plan = {
      steps: [{ id: 'only', tool: 'chat', input: {} }],
      needsSynthesis: false,
    }
    const out = planToMermaid(noDeps)
    expect(out).not.toContain('-->')
  })

  test('unknown tool → default grey style', () => {
    const out = planToMermaid({
      steps: [{ id: 'x', tool: 'weird-tool', input: {} }],
      needsSynthesis: false,
    })
    expect(out).toContain('fill:#f1f5f9')
  })

  test('empty plan → just the directive', () => {
    const out = planToMermaid(emptyPlan)
    expect(out).toBe('flowchart TD')
  })

  test('long question is truncated in node label', () => {
    const longQ = 'a'.repeat(100)
    const out = planToMermaid({
      steps: [{ id: 's', tool: 'sql', input: { question: longQ } }],
      needsSynthesis: false,
    })
    expect(out).toContain('…')
    expect(out).not.toContain('a'.repeat(100))
  })
})

describe('planToMermaidGrouped', () => {
  test('parallel steps grouped into subgraph', () => {
    const out = planToMermaidGrouped(parallelPlan)
    expect(out).toContain('subgraph level0')
    expect(out).toContain('end')
  })

  test('single step per level → no subgraph', () => {
    const out = planToMermaidGrouped(linearPlan)
    expect(out).not.toContain('subgraph')
  })

  test('still emits dependency edges', () => {
    const out = planToMermaidGrouped(parallelPlan)
    expect(out).toContain('s1 --> s3')
    expect(out).toContain('s2 --> s3')
  })
})
