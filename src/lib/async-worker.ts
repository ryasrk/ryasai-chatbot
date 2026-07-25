interface AsyncTask {
  id: string
  type: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  input: Record<string, unknown>
  output?: string
  error?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
}

const tasks = new Map<string, AsyncTask>()
const queue: string[] = []
let workerRunning = false

type TaskHandler = (task: AsyncTask) => Promise<string>

const handlers: Record<string, TaskHandler> = {}

export function registerHandler(type: string, handler: TaskHandler) {
  handlers[type] = handler
}

export function enqueue(type: string, input: Record<string, unknown>): string {
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const task: AsyncTask = {
    id,
    type,
    status: 'pending',
    input,
    createdAt: Date.now(),
  }
  tasks.set(id, task)
  queue.push(id)
  processQueue()
  return id
}

export function getTask(id: string): AsyncTask | undefined {
  return tasks.get(id)
}

export function listTasks(limit: number = 20): AsyncTask[] {
  return Array.from(tasks.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
}

export function clearCompleted() {
  for (const [id, task] of tasks) {
    if (task.status === 'completed' || task.status === 'failed') {
      if (Date.now() - (task.completedAt ?? 0) > 60000) {
        tasks.delete(id)
      }
    }
  }
}

async function processQueue() {
  if (workerRunning) return
  workerRunning = true
  while (queue.length > 0) {
    const taskId = queue.shift()!
    const task = tasks.get(taskId)
    if (!task) continue
    const handler = handlers[task.type]
    if (!handler) {
      task.status = 'failed'
      task.error = `No handler for type: ${task.type}`
      task.completedAt = Date.now()
      continue
    }
    task.status = 'running'
    task.startedAt = Date.now()
    try {
      task.output = await handler(task)
      task.status = 'completed'
    } catch (e) {
      task.error = e instanceof Error ? e.message : String(e)
      task.status = 'failed'
    }
    task.completedAt = Date.now()
  }
  workerRunning = false
  clearCompleted()
}
