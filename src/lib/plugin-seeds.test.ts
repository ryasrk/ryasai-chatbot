import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { normalizeManifest } from './plugin-registry'

/**
 * The built-in plugins are seeded into every install, so a defect here is a
 * defect every customer gets on day one.
 *
 * Read from SOURCE rather than importing the module, because the array is not
 * exported — and testing what ships is the point.
 */
const src = readFileSync(new URL('./plugin-seeds.ts', import.meta.url), 'utf8')

function manifestFor(toolId: string): Record<string, unknown> {
  const block = src.split(/\n  \{\n/).find((b) => b.includes(`toolId: '${toolId}'`))
  if (!block) throw new Error(`no seed block for ${toolId}`)
  const start = block.indexOf('manifest: {')
  const body = block.slice(start + 'manifest: '.length)
  const end = body.lastIndexOf('\n    },')
  return new Function(`return (${body.slice(0, end + '\n    }'.length)})`)() as Record<string, unknown>
}

const IDS = [...src.matchAll(/toolId: '([^']+)'/g)].map((m) => m[1])

describe('built-in plugin seeds', () => {
  test('there are 9 built-ins and every id is unique', () => {
    expect(IDS.length).toBe(9)
    expect(new Set(IDS).size).toBe(9)
  })

  test('EVERY built-in declares a JSON Schema for its arguments', () => {
    // Without one the model is handed a single free-text `input` field and must
    // invent the argument shape. All nine shipped that way before this test.
    for (const id of IDS) {
      const m = manifestFor(id)
      expect(m.parameters, `${id} has no parameters schema`).toBeDefined()
      const schema = m.parameters as { type?: string; properties?: Record<string, unknown> }
      expect(schema.type, `${id} schema is not an object`).toBe('object')
      expect(Object.keys(schema.properties ?? {}).length, `${id} schema has no properties`).toBeGreaterThan(0)
    }
  })

  test('every built-in manifest passes validation', () => {
    for (const id of IDS) {
      const norm = normalizeManifest(manifestFor(id))
      if ('error' in norm) throw new Error(`${id}: ${norm.error}`)
      expect(norm.executorType).toBe('webhook')
    }
  })

  test('every required parameter is also declared as a property', () => {
    // A required name with no matching property is unsatisfiable: the model
    // cannot supply it, and the request is rejected server-side.
    for (const id of IDS) {
      const schema = manifestFor(id).parameters as { properties?: Record<string, unknown>; required?: string[] }
      for (const r of schema.required ?? []) {
        expect(Object.keys(schema.properties ?? {}), `${id} requires "${r}" but does not declare it`).toContain(r)
      }
    }
  })

  test('enum-constrained parameters declare their allowed values', () => {
    // Pinning `format=json` and friends is what stops a model from omitting them
    // and getting HTML back, which then fails to parse.
    for (const id of IDS) {
      const schema = manifestFor(id).parameters as { properties?: Record<string, { enum?: unknown[] }> }
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        if (prop.enum) expect(prop.enum.length, `${id}.${name} has an empty enum`).toBeGreaterThan(0)
      }
    }
  })

  test('NO plugin points at the known-dead timeapi zone endpoint', () => {
    // `https://timeapi.io/api/time/zone` returns 404 (measured). Shipping it
    // meant a plugin that could never work.
    expect(src).not.toContain('api/time/zone?')
    expect(src).not.toContain("endpoint: 'https://timeapi.io/api/time/zone'")
  })

  test('no plugin keeps a prose-only paramDescription as its argument contract', () => {
    // paramDescription is descriptive text; it is not a contract. Every schema
    // must exist INDEPENDENTLY of it.
    for (const id of IDS) {
      expect((manifestFor(id) as { parameters?: unknown }).parameters, id).toBeDefined()
    }
  })
})
