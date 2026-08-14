import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { exportSession } from '@/lib/conversation-export'
import { enterWithOrg } from '@/lib/prisma-tenant'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { id } = await ctx.params
    const format = req.nextUrl.searchParams.get('format') === 'markdown' ? 'markdown' : 'json'
    const output = await exportSession(id, format)
    const contentType = format === 'markdown' ? 'text/markdown; charset=utf-8' : 'application/json'
    return new NextResponse(output, {
      status: 200,
      headers: { 'Content-Type': contentType },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to export session.')
  }
}
