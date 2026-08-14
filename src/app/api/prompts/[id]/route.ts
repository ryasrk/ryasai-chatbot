import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { getPrompt, updatePrompt, deletePrompt } from '@/lib/prompt-library'
import { enterWithOrg } from '@/lib/prisma-tenant'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { id } = await ctx.params
    const prompt = await getPrompt(id)
    if (!prompt) return NextResponse.json({ ok: false, error: 'Prompt not found.' }, { status: 404 })
    return NextResponse.json({ ok: true, prompt })
  } catch (e) {
    return handleApiError(e, 'Failed to load prompt.')
  }
}

export async function PUT(req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as {
      title?: string
      content?: string
      category?: string
      isPublic?: boolean
    }
    const existing = await getPrompt(id)
    if (!existing) return NextResponse.json({ ok: false, error: 'Prompt not found.' }, { status: 404 })
    const prompt = await updatePrompt(id, body)
    await writeAudit({
      userId: user.userId,
      action: 'PROMPT_UPDATE',
      severity: 'info',
      detail: { id, changes: body },
    })
    return NextResponse.json({ ok: true, prompt })
  } catch (e) {
    return handleApiError(e, 'Failed to update prompt.')
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        const { id } = await ctx.params
    const existing = await getPrompt(id)
    if (!existing) return NextResponse.json({ ok: false, error: 'Prompt not found.' }, { status: 404 })
    await deletePrompt(id)
    await writeAudit({
      userId: user.userId,
      action: 'PROMPT_DELETE',
      severity: 'warning',
      detail: { id, title: existing.title },
    })
    return NextResponse.json({ ok: true, deleted: true })
  } catch (e) {
    return handleApiError(e, 'Failed to delete prompt.')
  }
}
