import { createRequire } from 'node:module'
import { describe, expect, test } from 'bun:test'
const require = createRequire(import.meta.url)
const braces = require('braces') as {
  (pattern: string, options?: {expand?: boolean}): string[]
  parse(pattern: string): unknown
  compile(ast: unknown): unknown
  expand(ast: unknown): unknown
  stringify(ast: unknown): unknown
}
// GHSA-vfj7-8cjw-p6xm has no upstream fixed version. The locked Bun patch
// bounds recursive AST depth without changing ordinary development globs.
describe('braces stack exhaustion mitigation', () => {
  test('ordinary nested brace patterns retain their expansion', () => {
    expect(braces('src/{app,lib}/{*.ts,*.tsx}', { expand: true })).toEqual([
      'src/app/*.ts', 'src/app/*.tsx', 'src/lib/*.ts', 'src/lib/*.tsx',
    ])
  })
  test('deep patterns reject predictably before exhausting the stack', () => {
    for (const pattern of ['{'.repeat(4_000) + 'a,b' + '}'.repeat(4_000), '('.repeat(4_000) + 'a' + ')'.repeat(4_000)]) {
      expect(() => braces.parse(pattern)).toThrow('Brace nesting exceeds safe depth')
    }
  })
  test('public AST walkers also reject excessive depth', () => {
    let ast: unknown = { type: 'text', value: 'a' }
    for (let i = 0; i < 1000; i++) ast = { type: 'root', nodes: [ast] }
    for (const walk of [braces.compile, braces.expand, braces.stringify]) expect(() => walk(ast)).toThrow('Brace nesting exceeds safe depth')
  })
})
