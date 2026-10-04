/**
 * Architecture ratchets for `src/lib`: no NEW import cycle, no NEW oversized module, and no listed module growing.
 *
 * WHY A RATCHET. Measured on 2026-10-04: three static import cycles (the largest spans the router, planner, agentic
 * loop, tool selector and unified tools) and nine non-test modules over 800 lines. Neither is fixed by decree; what can
 * be enforced is that they only get better. Shrinking a listed file, or breaking a cycle, is free — then lower the
 * number here (or delete the entry) in the same change, so the ratchet tightens behind the improvement.
 *
 * Static `import`/`export … from` only: type-only imports are erased, and a dynamic `import()` is the documented way
 * this codebase breaks a runtime cycle.
 */
import { describe, expect, test } from 'bun:test'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const MAX_LINES = 800

/** Current size of each module already over budget. A listed module may shrink, never grow. */
const OVERSIZED_BASELINE: Record<string, number> = {
  'real-connectors.ts': 1297,
  'ai.ts': 1047,
  'unified-tools.ts': 997,
  'planner.ts': 991,
  'mcp-client.ts': 987,
  'intent-pipeline.ts': 948,
  'rag-retrieval.ts': 863,
  'tool-router.ts': 832,
  'admin-tools.ts': 804,
}

/** Existing cycles, as sorted member lists. A cycle not listed here fails; a listed one may shrink or disappear. */
const CYCLE_BASELINE: string[][] = [
  ['errors.ts', 'session.ts'],
  ['knowledge-graph.ts', 'rag-retrieval.ts', 'rag.ts'],
  ['planner.ts', 'tool-router-agentic.ts', 'tool-router.ts', 'tool-selector.ts', 'unified-tools.ts'],
]

const files = globSync('src/lib/**/*.ts', { cwd: ROOT }).filter((f) => !f.endsWith('.test.ts'))
const known = new Set(files)
const short = (f: string) => f.replace(/^src\/lib\//, '')

function resolveSpec(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = 'src/' + spec.slice(2)
  else if (spec.startsWith('.')) base = relative(ROOT, resolve(ROOT, dirname(from), spec))
  else return null
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) if (known.has(candidate)) return candidate
  return null
}

function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>()
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    const deps: string[] = []
    for (const m of src.matchAll(/^(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)) {
      const target = resolveSpec(f, m[1])
      if (target) deps.push(target)
    }
    graph.set(f, deps)
  }
  return graph
}

/** Strongly connected components with more than one member (Tarjan), each as a sorted list of short names. */
function cycles(graph: Map<string, string[]>): string[][] {
  let next = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []
  const visit = (v: string) => {
    index.set(v, next)
    low.set(v, next)
    next++
    stack.push(v)
    onStack.add(v)
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        component.push(short(w))
      } while (w !== v)
      if (component.length > 1) out.push(component.sort())
    }
  }
  for (const v of graph.keys()) if (!index.has(v)) visit(v)
  return out
}

describe('src/lib module budget', () => {
  test(`no module grows past ${MAX_LINES} lines, and no listed oversized module grows`, () => {
    const violations: string[] = []
    for (const f of files) {
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n').length
      const cap = OVERSIZED_BASELINE[short(f)] ?? MAX_LINES
      if (lines > cap) violations.push(`${short(f)}: ${lines} lines (cap ${cap})`)
    }
    expect(violations).toEqual([])
  })

  test('the oversized baseline names only files that still exist', () => {
    const present = new Set(files.map(short))
    expect(Object.keys(OVERSIZED_BASELINE).filter((f) => !present.has(f))).toEqual([])
  })

  test('no new import cycle: every cycle is (a subset of) a known one', () => {
    const found = cycles(importGraph())
    const allowed = CYCLE_BASELINE.map((c) => new Set(c))
    const fresh = found.filter((c) => !allowed.some((a) => c.every((m) => a.has(m))))
    expect(fresh).toEqual([])
  })
})
