import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { listPrompts, createPrompt } from '@/lib/prompt-library'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        const sp = req.nextUrl.searchParams
    const filter: { userId?: string; category?: string; isPublic?: boolean } = {}
    if (sp.get('userId')) filter.userId = sp.get('userId')!
    if (sp.get('category')) filter.category = sp.get('category')!
    if (sp.get('isPublic') === 'true') filter.isPublic = true
    if (sp.get('mine') === 'true') filter.userId = user.userId
    const prompts = await listPrompts(filter)
    return NextResponse.json({ ok: true, prompts })
  } catch (e) {
    return handleApiError(e, 'Failed to list prompts.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        const body = (await req.json().catch(() => ({}))) as {
      title?: string
      content?: string
      category?: string
      isPublic?: boolean
    }
    const title = (body.title ?? '').trim()
    if (!title) return NextResponse.json({ ok: false, error: 'Title is required.' }, { status: 400 })
    const content = (body.content ?? '').trim()
    if (!content) return NextResponse.json({ ok: false, error: 'Content is required.' }, { status: 400 })

    const prompt = await createPrompt(user.userId, {
      title,
      content,
      category: body.category,
      isPublic: body.isPublic,
    })
    await writeAudit({
      userId: user.userId,
      action: 'PROMPT_CREATE',
      severity: 'info',
      detail: { id: prompt.id, title },
    })
    return NextResponse.json({ ok: true, prompt }, { status: 201 })
  } catch (e) {
    return handleApiError(e, 'Failed to create prompt.')
  }
}
