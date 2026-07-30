import { NextRequest, NextResponse } from 'next/server'
import { handleApiError } from '@/lib/session'
import { processIncomingWebhook, type WebhookPayload } from '@/lib/incoming-webhook'
import { writeAudit } from '@/lib/session'

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text()
    const signature = req.headers.get('x-webhook-signature') ?? ''
    const payload = JSON.parse(rawBody) as WebhookPayload
    if (!payload.query || typeof payload.query !== 'string') {
      return NextResponse.json({ ok: false, error: 'query is required.' }, { status: 400 })
    }
    const result = await processIncomingWebhook(payload, signature, rawBody)
    await writeAudit({
      action: 'WEBHOOK_INCOMING',
      severity: 'info',
      detail: { query: payload.query.slice(0, 100), answerLen: result.answer.length },
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = /signature|secret/i.test(msg) ? 401 : 500
    return handleApiError(e, 'Webhook processing failed.', status)
  }
}
