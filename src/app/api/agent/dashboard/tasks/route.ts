import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enqueue, getTask, listTasks } from '@/lib/async-worker'
import { runNonStreamingChatCompletion } from '@/lib/tool-router'

export async function GET(req: NextRequest) {
  try {
    await getActiveUser()
    const searchParams = req.nextUrl.searchParams
    const taskId = searchParams.get('taskId')
    if (taskId) {
      const task = getTask(taskId)
      if (!task) return NextResponse.json({ error: 'Task tidak ditemukan.' }, { status: 404 })
      return NextResponse.json({ ok: true, task })
    }
    return NextResponse.json({ ok: true, tasks: listTasks(20) })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat tasks.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    const body = (await req.json().catch(() => ({}))) as { type?: string; question?: string }
    const type = body.type ?? 'chat'
    if (type === 'chat' && body.question) {
      const taskId = enqueue('chat', { question: body.question, userId: user.userId })
      return NextResponse.json({ ok: true, taskId, message: 'Task queued. Poll GET /api/agent/dashboard/tasks?taskId=... for status.' })
    }
    return NextResponse.json({ error: 'Type dan question wajib diisi.' }, { status: 400 })
  } catch (e) {
    return handleApiError(e, 'Gagal membuat task.')
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
