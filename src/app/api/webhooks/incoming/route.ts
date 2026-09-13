import { NextRequest, NextResponse } from 'next/server'
import { handleApiError } from '@/lib/session'
import { processIncomingWebhook, WebhookAuthError, type WebhookPayload } from '@/lib/incoming-webhook'
import { writeAudit } from '@/lib/session'

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text()
    const signature = req.headers.get('x-webhook-signature') ?? ''
    // A body that does not parse is a CLIENT error. Without this branch the JSON.parse throw became a 500, which
    // reports a malformed request as a server fault and makes monitoring treat a bad caller as an outage.
    let payload: WebhookPayload
    try {
      payload = JSON.parse(rawBody) as WebhookPayload
    } catch {
      return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 })
    }
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
    // 401 is decided by the ERROR TYPE, never by matching text. The previous regex-based rule returned 401 for
    // any failure whose message merely contained the word "signature" or "secret" -- so an unrelated upstream
    // error ("llm provider secret rotation failed") was reported to the caller as an authentication failure.
    const status = e instanceof WebhookAuthError ? 401 : 500
    return handleApiError(e, 'Webhook processing failed.', status)
  }
}
