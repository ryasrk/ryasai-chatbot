import type { Plan, PlanStep } from '@/lib/planner'

const TOOL_STYLES: Record<string, string> = {
  sql: 'fill:#dbeafe',
  rag: 'fill:#dcfce7',
  rest: 'fill:#fef9c3',
  chat: 'fill:#f3e8ff',
  plugin: 'fill:#fce7f3',
  mcp: 'fill:#e0e7ff',
}

function nodeLabel(step: PlanStep): string {
  const inputHint = step.input?.question ? `: ${truncate(step.input.question, 24)}` : ''
  return `${step.id}["${step.id} — ${step.tool}${inputHint}"]`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function planToMermaid(plan: Plan): string {
  const lines = ['flowchart TD']
  for (const step of plan.steps) {
    lines.push(`  ${nodeLabel(step)}`)
    const style = TOOL_STYLES[step.tool] ?? 'fill:#f1f5f9'
    lines.push(`  style ${step.id} ${style}`)
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn ?? []) {
      lines.push(`  ${dep} --> ${step.id}`)
    }
  }
  return lines.join('\n')
}

export function planToMermaidGrouped(plan: Plan): string {
  const lines = ['flowchart TD']
  const levels = groupByLevel(plan.steps)
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].length > 1) {
      lines.push(`  subgraph level${i}`)
      for (const step of levels[i]) {
        lines.push(`    ${nodeLabel(step)}`)
      }
      lines.push('  end')
    } else {
      const step = levels[i][0]
      lines.push(`  ${nodeLabel(step)}`)
    }
    for (const step of levels[i]) {
      const style = TOOL_STYLES[step.tool] ?? 'fill:#f1f5f9'
      lines.push(`  style ${step.id} ${style}`)
    }
  }
  for (const step of plan.steps) {
    for (const dep of step.dependsOn ?? []) {
      lines.push(`  ${dep} --> ${step.id}`)
    }
  }
  return lines.join('\n')
}

function groupByLevel(steps: PlanStep[]): PlanStep[][] {
  const levels: PlanStep[][] = []
  const done = new Set<string>()
  const remaining = [...steps]
  while (remaining.length > 0) {
    const current = remaining.filter((s) => (s.dependsOn ?? []).every((d) => done.has(d)))
    if (current.length === 0) break // ponytail: cycle guard — stops if deps unresolved
    levels.push(current)
    for (const s of current) done.add(s.id)
    for (const s of current) {
      const idx = remaining.indexOf(s)
      if (idx >= 0) remaining.splice(idx, 1)
    }
  }
  return levels
}
