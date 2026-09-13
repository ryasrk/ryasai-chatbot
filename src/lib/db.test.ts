/**
 * `db.ts` — specifically `isPrismaNotFound`, the ONE exported function in the module.
 *
 * HOW THIS WAS FOUND. A per-file FUNCTION-coverage number (FNF/FNH, added to
 * `scripts/coverage.ts` this round) reported `src/lib/db.ts` as the single file in `src/` that
 * entered ZERO of its functions. Line coverage had been at 11/12 for a long time and looked
 * unremarkable; the function ratio is what exposed that the one function there had never run.
 *
 * WHY IT MATTERS. `isPrismaNotFound` is the single predicate four production routes use to tell
 * "this row does not exist" (→ 404, a normal outcome the UI handles) from "the query failed"
 * (→ 500). Every test that touches it MOCKS it (e.g.
 * `integrations/[id]/route.test.ts`: `isPrismaNotFound: (e) => /P2025/.test(e.message)`), so the
 * real implementation was never executed -- and a mocked predicate cannot tell you whether the
 * real one recognises the error shape Prisma actually throws.
 */
import { describe, expect, test } from 'bun:test'
import { isPrismaNotFound } from './db'

/** A Prisma "record not found" error as the driver surfaces it. */
function prismaNotFound(): Error & { code: string } {
  const e = new Error(
    'An operation failed because it depends on one or more records that were required but not found. Record to update not found.',
  ) as Error & { code: string }
  e.code = 'P2025'
  return e
}

describe('isPrismaNotFound — recognises the not-found error', () => {
  test('a P2025-coded error is recognised', () => {
    expect(isPrismaNotFound(prismaNotFound())).toBe(true)
  })

  test('the code is read from a PLAIN OBJECT too, not only an Error instance', () => {
    // Prisma's error objects are not always `Error` instances after they cross a serialization or
    // extension boundary; the implementation deliberately uses a structural check
    // (`typeof e === 'object' && e.code`), so this pins that it is NOT an `instanceof` test.
    expect(isPrismaNotFound({ code: 'P2025' })).toBe(true)
    // A nested/cause shape carrying the code at the top level.
    expect(isPrismaNotFound({ code: 'P2025', message: 'not found', meta: { modelName: 'Document' } })).toBe(true)
  })
})

describe('isPrismaNotFound — does NOT swallow other failures', () => {
  test('a DIFFERENT Prisma code is not a not-found', () => {
    // P2002 is the unique-constraint violation and P2003 the FK violation. Reporting either as
    // "404 not found" would hide a genuine write conflict from the operator and tell the UI the
    // row is simply absent.
    for (const code of ['P2002', 'P2003', 'P1001', 'P2024']) {
      expect(isPrismaNotFound({ code })).toBe(false)
    }
  })

  test('an Error with a P2025 mention in its MESSAGE but no code is NOT accepted', () => {
    // The distinguishing property against the mock used in the route tests: those mocks match
    // /P2025/ against `e.message`. The real implementation reads `.code`, so a message that merely
    // QUOTES P2025 -- a log wrapper, a rethrown error, an LLM-produced string -- must not count.
    expect(isPrismaNotFound(new Error('failed with P2025 somewhere in the text'))).toBe(false)
  })

  test('nullish and primitive inputs are false, never a throw', () => {
    // Called from a catch block: `isPrismaNotFound(undefined)` must not turn a handled 404 into an
    // unhandled TypeError. `throw null`, `throw 0` and `throw 'x'` are all legal JS.
    expect(isPrismaNotFound(null)).toBe(false)
    expect(isPrismaNotFound(undefined)).toBe(false)
    expect(isPrismaNotFound(0)).toBe(false)
    expect(isPrismaNotFound('')).toBe(false)
    expect(isPrismaNotFound('P2025')).toBe(false)
    expect(isPrismaNotFound(true)).toBe(false)
  })

  test('an object whose code is a NON-STRING is not accepted', () => {
    // A numeric or object `code` would make `=== 'P2025'` false; pinned so a future refactor to a
    // loose comparison is a visible decision.
    expect(isPrismaNotFound({ code: 2025 })).toBe(false)
    expect(isPrismaNotFound({ code: { value: 'P2025' } })).toBe(false)
    expect(isPrismaNotFound({ code: null })).toBe(false)
  })

  test('an empty object is false (no accidental truthiness)', () => {
    expect(isPrismaNotFound({})).toBe(false)
  })
})
