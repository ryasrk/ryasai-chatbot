import { describe, test } from 'bun:test'
import fc from 'fast-check'
import { validateAndSanitizeLlmSql } from './guardrails'
import { SQL_MAX_LIMIT } from '@/lib/constants'

const MUTATIONS = [
  'DELETE', 'UPDATE', 'INSERT', 'DROP', 'ALTER', 'TRUNCATE',
  'CREATE', 'GRANT', 'REVOKE', 'MERGE', 'CALL', 'EXEC', 'EXECUTE',
  'RENAME', 'VACUUM', 'REINDEX', 'ANALYZE', 'BEGIN', 'COMMIT', 'ROLLBACK',
]

const safeTable = fc.constantFrom('users', 'orders', 'products', 't1', 'data', 'sales', 'items', 'accounts')
const safeCol = fc.constantFrom('id', 'name', 'email', 'count', 'total', 'val', 'x')

function extractLimit(sql: string): number {
  const m = sql.match(/LIMIT\s+(\d+)/i)
  return m ? Number(m[1]) : Infinity
}

describe('validateAndSanitizeLlmSql — property tests', () => {
  test('mutation keywords are always blocked', () => {
    fc.assert(
      fc.property(fc.constantFrom(...MUTATIONS), safeTable, (kw, table) => {
        const r = validateAndSanitizeLlmSql(`${kw} ${table}`)
        return r.ok === false
      }),
    )
  })

  test('mutation keywords blocked even with arbitrary suffix', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MUTATIONS),
        fc.string({ minLength: 0, maxLength: 30 }).filter((s) => !s.includes("'") && !s.includes('"')),
        (kw, suffix) => {
          const r = validateAndSanitizeLlmSql(`${kw} FROM t1 ${suffix}`)
          return r.ok === false
        },
      ),
    )
  })

  test('valid SELECT queries always pass', () => {
    fc.assert(
      fc.property(safeCol, safeTable, (col, table) => {
        const r = validateAndSanitizeLlmSql(`SELECT ${col} FROM ${table}`)
        return r.ok === true
      }),
    )
  })

  test('multi-column SELECT always passes', () => {
    fc.assert(
      fc.property(
        fc.array(safeCol, { minLength: 1, maxLength: 5 }),
        safeTable,
        (cols, table) => {
          const r = validateAndSanitizeLlmSql(`SELECT ${cols.join(', ')} FROM ${table}`)
          return r.ok === true
        },
      ),
    )
  })

  test('LIMIT is always clamped to SQL_MAX_LIMIT or below', () => {
    fc.assert(
      fc.property(safeTable, fc.integer({ min: 0, max: 1_000_000 }), (table, n) => {
        const r = validateAndSanitizeLlmSql(`SELECT * FROM ${table} LIMIT ${n}`)
        return r.ok === true && extractLimit(r.sanitized) <= SQL_MAX_LIMIT
      }),
    )
  })

  test('SELECT without LIMIT always gets LIMIT appended at cap', () => {
    fc.assert(
      fc.property(safeTable, (table) => {
        const r = validateAndSanitizeLlmSql(`SELECT * FROM ${table}`)
        return r.ok === true && extractLimit(r.sanitized) === SQL_MAX_LIMIT
      }),
    )
  })

  test('stacked queries (semicolon + second statement) are always blocked', () => {
    fc.assert(
      fc.property(
        safeCol,
        safeTable,
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /[A-Za-z]/.test(s) && !s.includes("'") && !s.includes('"')),
        (col, table, payload) => {
          const r = validateAndSanitizeLlmSql(`SELECT ${col} FROM ${table}; ${payload}`)
          return r.ok === false
        },
      ),
    )
  })

  test('sanitized output always ends with semicolon and contains LIMIT', () => {
    fc.assert(
      fc.property(safeCol, safeTable, (col, table) => {
        const r = validateAndSanitizeLlmSql(`SELECT ${col} FROM ${table}`)
        return r.ok === true && r.sanitized.endsWith(';') && /\bLIMIT\b/i.test(r.sanitized)
      }),
    )
  })
})
