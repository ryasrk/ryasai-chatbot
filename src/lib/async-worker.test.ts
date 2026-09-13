import { describe, expect, test, beforeEach } from 'bun:test'
import { enqueue, registerHandler, getTask, listTasks, clearCompleted } from './async-worker'

async function wait(ms = 80) {
  await new Promise((r) => setTimeout(r, ms))
}

beforeEach(() => {
  // Re-register a default handler so cross-test state is predictable.
  registerHandler('test-default', async (t) => `ok:${JSON.stringify(t.input)}`)
})

describe('async-worker', () => {
  test('enqueue + registerHandler → task processes to completed', async () => {
    registerHandler('echo', async (t) => `processed:${t.input.val}`)
    const id = enqueue('echo', { val: 'hello' })
    await wait()
    const task = getTask(id)
    expect(task?.status).toBe('completed')
    expect(task?.output).toBe('processed:hello')
  })

  test('handler missing for type → task fails with error message', async () => {
    const id = enqueue('type-with-no-handler', { x: 1 })
    await wait()
    const task = getTask(id)
    expect(task?.status).toBe('failed')
    expect(task?.error).toContain('No handler')
  })

  test('a handler that THROWS marks the task failed with the message', async () => {
    // The other failure test covers a MISSING handler (an early `continue` at the top of the loop).
    // This covers the try/catch around the handler call itself, which had never executed. Without
    // it, a throwing handler would leave the task stuck at 'running' forever -- the caller polls
    // getTask() and waits on something that will never complete.
    registerHandler('boom', async () => {
      throw new Error('handler exploded')
    })
    const id = enqueue('boom', {})
    await wait()

    const task = getTask(id)
    expect(task?.status).toBe('failed')
    expect(task?.error).toBe('handler exploded')
    // The failure is still TIMED, so a poller can tell it is not merely old.
    expect(task?.completedAt).toBeGreaterThan(0)
  })

  test('a handler that throws a NON-Error value still records a string', async () => {
    // `throw 'string'` and `throw {code:1}` are legal JS. String(e) is the fallback that keeps
    // `task.error` a string, which the API and UI both assume.
    registerHandler('boom-nonerror', async () => {
      throw 'just a string'
    })
    const id = enqueue('boom-nonerror', {})
    await wait()

    const task = getTask(id)
    expect(task?.status).toBe('failed')
    expect(task?.error).toBe('just a string')
  })

  test('after a THROWING task the worker still processes the NEXT task', async () => {
    // A catch that did not return the worker to the loop would poison the queue: one bad handler
    // would stop every later task from ever running.
    registerHandler('boom-then-ok', async (t) => {
      if (t.input.fail) throw new Error('nope')
      return 'recovered'
    })
    enqueue('boom-then-ok', { fail: true })
    await wait(40)
    const okId = enqueue('boom-then-ok', { fail: false })
    await wait(40)

    expect(getTask(okId)?.status).toBe('completed')
    expect(getTask(okId)?.output).toBe('recovered')
  })

  test('listTasks returns tasks sorted by createdAt desc', async () => {
    const id1 = enqueue('test-default', { n: 1 })
    await wait(30)
    const id2 = enqueue('test-default', { n: 2 })
    await wait()
    const tasks = listTasks(100).filter((t) => t.id === id1 || t.id === id2)
    expect(tasks).toHaveLength(2)
    expect(tasks[0].id).toBe(id2)
    expect(tasks[1].id).toBe(id1)
  })

  test('clearCompleted does NOT remove fresh completed tasks (< 60s)', async () => {
    const id = enqueue('test-default', { fresh: true })
    await wait()
    expect(getTask(id)?.status).toBe('completed')
    clearCompleted()
    expect(getTask(id)).toBeDefined()
  })

  test('clearCompleted removes completed tasks older than 60s', async () => {
    const realNow = Date.now
    const T0 = 5_000_000
    Date.now = () => T0
    registerHandler('old-task', async () => 'done')
    const id = enqueue('old-task', { x: 1 })
    await wait()
    expect(getTask(id)?.status).toBe('completed')
    Date.now = () => T0 + 70_000
    clearCompleted()
    expect(getTask(id)).toBeUndefined()
    Date.now = realNow
  })

  test('multiple tasks process in FIFO order', async () => {
    const order: string[] = []
    registerHandler('ordered', async (t) => {
      order.push(String(t.input.n))
      return 'ok'
    })
    enqueue('ordered', { n: '1' })
    enqueue('ordered', { n: '2' })
    enqueue('ordered', { n: '3' })
    await wait(120)
    expect(order).toEqual(['1', '2', '3'])
  })
})
