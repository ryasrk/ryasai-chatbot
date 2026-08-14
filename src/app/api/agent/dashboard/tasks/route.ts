import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enqueue, getTask, listTasks } from '@/lib/async-worker'
import { runNonStreamingChatCompletion } from '@/lib/tool-router'

export async function GET(req: NextRequest) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const searchParams = req.nextUrl.searchParams
    const taskId = searchParams.get('taskId')
    if (taskId) {
      const task = getTask(taskId)
      if (!task) return NextResponse.json({ error: 'Task not found.' }, { status: 404 })
      return NextResponse.json({ ok: true, task })
    }
    return NextResponse.json({ ok: true, tasks: listTasks(20) })
  } catch (e) {
    return handleApiError(e, 'Failed to load tasks.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        const body = (await req.json().catch(() => ({}))) as { type?: string; question?: string }
    const type = body.type ?? 'chat'
    if (type === 'chat' && body.question) {
      const taskId = enqueue('chat', { question: body.question, userId: user.userId })
      return NextResponse.json({ ok: true, taskId, message: 'Task queued. Poll GET /api/agent/dashboard/tasks?taskId=... for status.' })
    }
    return NextResponse.json({ error: 'Type and question are required.' }, { status: 400 })
  } catch (e) {
    return handleApiError(e, 'Failed to create task.')
  }
}

registerHandler('chat', async (task) => {
  const result = await runNonStreamingChatCompletion({
    question: task.input.question as string,
    userId: task.input.userId as string,
  })
  return result.answer
})

import { registerHandler } from '@/lib/async-worker'
import { enterWithOrg } from '@/lib/prisma-tenant'
