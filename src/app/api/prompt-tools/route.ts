import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { getPromptSettings, mergePromptSettings, type PromptSettings } from '@/lib/prompt-settings'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * GET /api/prompt-tools → { ok: true, settings: PromptSettings }
 * PUT /api/prompt-tools → { ok: true, settings } (merged partial update)
 *   Body: {
 *     systemPrompt?: string,           // org-wide system prompt (merged into systemPromptPrefix)
 *     ragContextPrompt?: string,       // org-wide RAG context prompt (prepended to RAG answers)
 *     tools?: Partial<{rag,sql,restApi}>
 *   }
 *
 * `ragContextPrompt` flows through `mergePromptSettings` (src/lib/prompt-settings.ts),
 * which already accepts the field; GET returns the full settings shape via
 * `getPromptSettings`, so `ragContextPrompt` is included automatically.
 */
export async function GET() {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const settings = await getPromptSettings(db)
    return NextResponse.json({ ok: true, settings })
  } catch (e) {
    return handleApiError(e, 'Failed to load prompt settings.')
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')
    const body = await req.json().catch(() => ({}))
    const current = await getPromptSettings(db)
    const merged: PromptSettings = mergePromptSettings(current, body)

    const existing = await db.appConfig.findFirst()
    if (existing) {
      await db.appConfig.update({ where: { id: existing.id }, data: { promptSettings: JSON.stringify(merged) } })
    } else {
      await db.appConfig.create({ data: { organizationId: user.organizationId, promptSettings: JSON.stringify(merged) } })
    }

    await writeAudit({
      userId: user.userId,
      action: 'PROMPT_TOOLS_UPDATE',
      detail: {
        tools: merged.tools,
        systemPromptLength: merged.systemPrompt.length,
        ragContextPromptLength: merged.ragContextPrompt.length,
      },
    })

    return NextResponse.json({ ok: true, settings: merged })
  } catch (e) {
    return handleApiError(e, 'Failed to save prompt settings.')
  }
}
