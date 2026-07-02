import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { getPromptSettings, mergePromptSettings, type PromptSettings } from '@/lib/prompt-settings'

/**
 * GET /api/prompt-tools → { ok: true, settings: PromptSettings }
 * PUT /api/prompt-tools → { ok: true, settings } (merged partial update)
 *   Body: { systemPrompt?: string, tools?: Partial<{rag,sql,restApi}> }
 */
export async function GET() {
  try {
    const user = await getActiveUser()
    const settings = await getPromptSettings(db, user.companyId)
    return NextResponse.json({ ok: true, settings })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat pengaturan prompt.')
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getActiveUser()
    const body = await req.json().catch(() => ({}))
    const current = await getPromptSettings(db, user.companyId)
    const merged: PromptSettings = mergePromptSettings(current, body)

    await db.appConfig.upsert({
      where: { companyId: user.companyId },
      create: { companyId: user.companyId, promptSettings: JSON.stringify(merged) },
      update: { promptSettings: JSON.stringify(merged) },
    })

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'PROMPT_TOOLS_UPDATE',
      detail: { tools: merged.tools, systemPromptLength: merged.systemPrompt.length },
    })

    return NextResponse.json({ ok: true, settings: merged })
  } catch (e) {
    return handleApiError(e, 'Gagal menyimpan pengaturan prompt.')
  }
}
