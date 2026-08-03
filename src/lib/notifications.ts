/**
 * notifications — delivers scheduled-run results to configured channels.
 * ===========================================================================
 * webhook:   POST JSON {title, message, timestamp} to URL (optional Bearer).
 *            If signatureSecret is set, signs body with HMAC-SHA256 and sends
 *            X-Signature-256 header (Stripe/GitHub convention) so receivers
 *            can verify sender authenticity.
 * telegram:  sendMessage to chat_id via Bot API.
 * email:     stub — requires SMTP setup (nodemailer not installed). Returns
 *            a clear error so callers can fall back to webhook/telegram.
 *
 * Config is AES-256-GCM encrypted in DB; decrypt here at send time. The
 * `type` field is packed into the encrypted blob so sendNotification only
 * needs the encrypted string.
 */
import crypto from 'crypto'
import { decryptConfig } from '@/lib/crypto'
import {
  NOTIFICATION_MAX_RETRIES,
  NOTIFICATION_BACKOFF_BASE_MS,
  NOTIFICATION_TIMEOUT_MS,
} from '@/lib/constants'

export interface NotificationResult {
  ok: boolean
  error?: string
  latencyMs: number
}

export async function sendNotification(args: {
  configEncrypted: string
  message: string
  title?: string
}): Promise<NotificationResult> {
  const started = Date.now()
  let config: Record<string, unknown>
  try {
    config = decryptConfig(args.configEncrypted)
  } catch {
    return { ok: false, error: 'Invalid notification configuration.', latencyMs: 0 }
  }

  const type = config.type as string
  try {
    if (type === 'webhook') return await sendWebhook(config, args.message, args.title, started)
    if (type === 'telegram') return await sendTelegram(config, args.message, args.title, started)
    if (type === 'email') return await sendEmail(config, args.message, args.title, started)
    return {
      ok: false,
      error: `Unknown notification type: ${type}`,
      latencyMs: Date.now() - started,
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      latencyMs: Date.now() - started,
    }
  }
}

async function sendWebhook(
  config: Record<string, unknown>,
  message: string,
  title: string | undefined,
  started: number,
): Promise<NotificationResult> {
  const url = config.url as string
  const token = config.token as string | undefined
  const signatureSecret = config.signatureSecret as string | undefined
  const body = JSON.stringify({
    title: title ?? 'ryasai notification',
    message,
    timestamp: new Date().toISOString(),
  })
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
  // ponytail: HMAC-SHA256 signature when secret is configured — receiver verifies with same secret.
  if (signatureSecret) {
    const sig = crypto.createHmac('sha256', signatureSecret).update(body).digest('hex')
    headers['X-Signature-256'] = `sha256=${sig}`
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
  })
  const latencyMs = Date.now() - started
  if (!res.ok) return { ok: false, error: `Webhook HTTP ${res.status}`, latencyMs }
  return { ok: true, latencyMs }
}

async function sendTelegram(
  config: Record<string, unknown>,
  message: string,
  title: string | undefined,
  started: number,
): Promise<NotificationResult> {
  const botToken = config.botToken as string
  const chatId = config.chatId as string
  const text = `${title ? `*${title}*\n\n` : ''}${message}`
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { // nosemgrep — legitimate Telegram notification integration, botToken from server-side DB config
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
  })
  const latencyMs = Date.now() - started
  if (!res.ok) return { ok: false, error: `Telegram API HTTP ${res.status}`, latencyMs }
  return { ok: true, latencyMs }
}

// ponytail: Resend — transactional email. API key + from-address come from env;
// the per-config encrypted blob only stores the recipient (`to`). Falls back to
// a clear error when RESEND_API_KEY is not set (keeps scheduler working for
// webhook/telegram even if email is unconfigured).
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? ''
const RESEND_FROM = process.env.EMAIL_FROM ?? 'ryasai@ryasai.my.id'
const RESEND_URL = 'https://api.resend.com/emails'

async function sendEmail(
  config: Record<string, unknown>,
  message: string,
  title: string | undefined,
  started: number,
): Promise<NotificationResult> {
  const to = config.to as string | undefined
  if (!to) return { ok: false, error: 'Email recipient (to) is required.', latencyMs: Date.now() - started }
  if (!RESEND_API_KEY) {
    return {
      ok: false,
      error: 'Email requires RESEND_API_KEY in .env. Use webhook or telegram for now.',
      latencyMs: Date.now() - started,
    }
  }

  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: title ?? 'ryasai notification',
      text: message,
    }),
    signal: AbortSignal.timeout(NOTIFICATION_TIMEOUT_MS),
  })
  const latencyMs = Date.now() - started
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return { ok: false, error: `Resend API HTTP ${res.status} ${detail.slice(0, 160)}`, latencyMs }
  }
  return { ok: true, latencyMs }
}

// ---------------------------------------------------------------------------
// Retry wrapper — exponential backoff for transient failures.
// ponytail: in-memory retry (no BullMQ). Ceiling: retries are lost on server
// restart. Upgrade to BullMQ-based retry queue when durability is needed.
// ---------------------------------------------------------------------------

export async function sendNotificationWithRetry(args: {
  configEncrypted: string
  message: string
  title?: string
}): Promise<NotificationResult> {
  let lastResult: NotificationResult = { ok: false, error: 'No attempt made.', latencyMs: 0 }

  for (let attempt = 0; attempt <= NOTIFICATION_MAX_RETRIES; attempt++) {
    lastResult = await sendNotification(args)
    if (lastResult.ok) return lastResult

    // Don't retry on config errors (decryption failed) — only on delivery failures
    if (lastResult.error?.includes('Invalid notification configuration') || lastResult.error?.includes('Unknown notification type')) {
      return lastResult
    }

    if (attempt < NOTIFICATION_MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, NOTIFICATION_BACKOFF_BASE_MS * 2 ** attempt))
    }
  }

  console.warn('[notifications] all retries exhausted:', lastResult.error)
  return lastResult
}
