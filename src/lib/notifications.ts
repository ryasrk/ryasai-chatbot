/**
 * notifications — delivers scheduled-run results to configured channels.
 * ===========================================================================
 * webhook:   POST JSON {title, message, timestamp} to URL (optional Bearer).
 * telegram:  sendMessage to chat_id via Bot API.
 * email:     stub — requires SMTP setup (nodemailer not installed). Returns
 *            a clear error so callers can fall back to webhook/telegram.
 *
 * Config is AES-256-GCM encrypted in DB; decrypt here at send time. The
 * `type` field is packed into the encrypted blob so sendNotification only
 * needs the encrypted string.
 */
import { decryptConfig } from '@/lib/crypto'

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
    return { ok: false, error: 'Konfigurasi notifikasi tidak valid.', latencyMs: 0 }
  }

  const type = config.type as string
  try {
    if (type === 'webhook') return await sendWebhook(config, args.message, args.title, started)
    if (type === 'telegram') return await sendTelegram(config, args.message, args.title, started)
    if (type === 'email') return await sendEmail(config, args.message, args.title, started)
    return {
      ok: false,
      error: `Tipe notifikasi tidak dikenal: ${type}`,
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
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      title: title ?? 'Notifikasi ryasai',
      message,
      timestamp: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(15000),
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
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    signal: AbortSignal.timeout(15000),
  })
  const latencyMs = Date.now() - started
  if (!res.ok) return { ok: false, error: `Telegram API HTTP ${res.status}`, latencyMs }
  return { ok: true, latencyMs }
}

// ponytail: email stub — nodemailer not installed. Add when SMTP is wired up.
async function sendEmail(
  _config: Record<string, unknown>,
  _message: string,
  _title: string | undefined,
  started: number,
): Promise<NotificationResult> {
  return {
    ok: false,
    error: 'Email notification memerlukan konfigurasi SMTP. Gunakan webhook atau telegram untuk sekarang.',
    latencyMs: Date.now() - started,
  }
}
