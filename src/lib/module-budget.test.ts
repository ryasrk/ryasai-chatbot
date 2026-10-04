/**
 * Architecture rules for `src/lib`: no import cycle, and no module longer than 800 lines.
 *
 * HISTORY. Measured on 2026-10-04: three static import cycles (the largest spanned the router, planner, agentic loop,
 * tool selector and unified tools) and nine non-test modules over 800 lines. This file began as a ratchet that only
 * let both numbers fall. Both reached zero the same day — the cycles broken with leaf modules and one explicit port,
 * the nine modules split along their seams with their public surface kept by re-export — so both are now absolute.
 * A module that needs to grow past the cap has two responsibilities: split it along the seam, not around the rule.
 *
 * Static `import`/`export … from` only: type-only imports are erased, and a dynamic `import()` is the documented way
 * this codebase breaks a runtime cycle.
 */
import { describe, expect, test } from 'bun:test'
import { globSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = join(import.meta.dir, '../..')
const MAX_LINES = 800

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
  test(`no module is longer than ${MAX_LINES} lines`, () => {
    const violations: string[] = []
    for (const f of files) {
      const lines = readFileSync(join(ROOT, f), 'utf8').split('\n').length
      if (lines > MAX_LINES) violations.push(`${short(f)}: ${lines} lines (cap ${MAX_LINES})`)
    }
    expect(violations).toEqual([])
  })

  test('no import cycle at all', () => {
    // The ratchet reached zero on 2026-10-04 (errors↔session via `session-errors.ts`, the RAG layer via the
    // `rag-scoring.ts` leaf, the router family via `chat-completion-port.ts`). From here a cycle is simply a defect:
    // break it with a leaf module or a port, never by adding it to a list.
    expect(cycles(importGraph())).toEqual([])
  })
})
