import { describe, expect, test, afterAll } from 'bun:test'
import {
  scheduleEvents,
  emitScheduleRunComplete,
  onScheduleRunComplete,
  type ScheduleRunEvent,
} from './schedule-events'

afterAll(() => {
  scheduleEvents.removeAllListeners()
})

function makeEvent(overrides?: Partial<ScheduleRunEvent>): ScheduleRunEvent {
  return {
    runId: 'run-1',
    name: 'Test Schedule',
    status: 'success',
    answer: 'result text',
    timestamp: new Date(),
    latencyMs: 500,
    ...overrides,
  }
}

describe('schedule-events', () => {
  test('emitScheduleRunComplete fires run:complete event', () => {
    let received: ScheduleRunEvent | null = null
    const off = onScheduleRunComplete((e) => {
      received = e
    })
    const event = makeEvent({ runId: 'emit-1' })
    emitScheduleRunComplete(event)
    expect(received).not.toBeNull()
    expect(received!.runId).toBe('emit-1')
    off()
  })

  test('multiple listeners all receive the event', () => {
    let count = 0
    const off1 = onScheduleRunComplete(() => {
      count++
    })
    const off2 = onScheduleRunComplete(() => {
      count++
    })
    emitScheduleRunComplete(makeEvent({ runId: 'multi-1' }))
    expect(count).toBe(2)
    off1()
    off2()
  })

  test('unsubscribe (off) stops receiving events', () => {
    let received = false
    const off = onScheduleRunComplete(() => {
      received = true
    })
    off()
    emitScheduleRunComplete(makeEvent({ runId: 'off-1' }))
    expect(received).toBe(false)
  })

  test('error status event carries error field', () => {
    let received: ScheduleRunEvent | null = null
    const off = onScheduleRunComplete((e) => {
      received = e
    })
    emitScheduleRunComplete(
      makeEvent({ runId: 'err-1', status: 'error', error: 'timeout', answer: undefined }),
    )
    expect(received!.status).toBe('error')
    expect(received!.error).toBe('timeout')
    expect(received!.answer).toBeUndefined()
    off()
  })

  test('latencyMs is preserved in the event', () => {
    let received: ScheduleRunEvent | null = null
    const off = onScheduleRunComplete((e) => {
      received = e
    })
    emitScheduleRunComplete(makeEvent({ runId: 'lat-1', latencyMs: 1234 }))
    expect(received!.latencyMs).toBe(1234)
    off()
  })
})
