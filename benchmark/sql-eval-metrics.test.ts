import { expect, test } from 'bun:test'
import { resultAccuracy, firstRowHasValue } from './sql-eval-metrics'

test('failed execution remains in the result-accuracy denominator', () => {
  const results = [
    { expected: 1, match: true },
    { expected: 1, match: false },
    { expected: 1, match: undefined },
    { expected: undefined, match: undefined },
  ]
  expect(resultAccuracy(results, r => r.expected !== undefined, r => r.match)).toBe(1 / 3)
  expect(resultAccuracy([], () => true, () => true)).toBeNull()
})

test('first-row scalar agreement tolerates aliases, additional fields and decimal formatting', () => {
  expect(firstRowHasValue({ average_salary: '75000.00', count: '8' }, '75000.000000000000')).toBe(true)
  expect(firstRowHasValue({ name: 'Hana', salary: 110000, active: true }, 'Hana')).toBe(true)
  expect(firstRowHasValue({ salary: 109999 }, 110000)).toBe(false)
  expect(firstRowHasValue({ name: 'Hannah' }, 'Hana')).toBe(false)
  expect(firstRowHasValue(undefined, 0)).toBe(false)
})
