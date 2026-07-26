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
