import { expect, test } from 'bun:test'
import { contextAveragePrecision } from './context-precision'

test('relevant chunks ranked first score higher, following the RAGAS examples', () => {
  expect(contextAveragePrecision([1, 0])).toBe(1)
  expect(contextAveragePrecision([0, 1])).toBe(0.5)
  expect(contextAveragePrecision([1, 0, 1])).toBeCloseTo(5 / 6)
  expect(contextAveragePrecision([0, 0])).toBe(0)
  expect(contextAveragePrecision([])).toBe(0)
})
test('an invalid chunk verdict invalidates the metric instead of reducing its denominator', () => {
  expect(contextAveragePrecision([1, NaN])).toBeNaN()
  expect(contextAveragePrecision([1, 0.5])).toBeNaN()
})
