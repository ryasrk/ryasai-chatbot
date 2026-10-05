'use client'

import { useEffect, useState } from 'react'
import { Loader2, Trash2, RefreshCw, Bell, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Delayed, TableSkeleton, ErrorState } from '@/components/ui/view-states'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export interface NotificationConfigItem {
  id: string
  name: string
  type: string
  isActive: boolean
  configured: boolean
  maskedConfig: Record<string, unknown>
}

export type NotifType = 'telegram' | 'email' | 'webhook'

export function NotificationsTab() {
  const [configs, setConfigs] = useState<NotificationConfigItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const [type, setType] = useState<NotifType>('telegram')
  const [name, setName] = useState('')
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [botUsername, setBotUsername] = useState('')
  const [emailTo, setEmailTo] = useState('')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookToken, setWebhookToken] = useState('')

  const load = () => {
    setLoading(true)
    fetch('/api/notifications', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load notification configs.')
        return r.json()
      })
      .then((d) => setConfigs(d.configs ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const reset = () => {
    setName(''); setBotToken(''); setChatId(''); setBotUsername('')
    setEmailTo(''); setWebhookUrl(''); setWebhookToken(''); setType('telegram')
  }

  const handleSave = async () => {
    let config: Record<string, unknown> | null = null
    if (type === 'telegram') {
      if (!botToken.trim() || !chatId.trim()) { toast.error('Bot token and chat ID are required.'); return }
      // Bot token format: 123456:ABC... — chat id: numeric or @channel
      config = { botToken: botToken.trim(), chatId: chatId.trim(), botUsername: botUsername.trim() }
    } else if (type === 'email') {
      if (!emailTo.trim()) { toast.error('Recipient email is required.'); return }
      config = { to: emailTo.trim() }
    } else {
      if (!webhookUrl.trim()) { toast.error('Webhook URL is required.'); return }
      // GitHub-style: {url, token} — receiver verifies via X-Signature-256 when signatureSecret set
      config = { url: webhookUrl.trim(), token: webhookToken.trim() || undefined, signatureSecret: undefined }
    }

    const finalName = name.trim() || `${type} config`
    setSaving(true)
    try {
      const res = await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: finalName, type, config }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.ok) {
        toast.success('Notification config saved.')
        setDialogOpen(false)
        reset()
        load()
      } else {
        const msg = typeof data?.error === 'string' ? data.error : data?.error?.message
        toast.error(msg || 'Failed to save notification config.')
      }
    } catch {
      toast.error('Network error while saving.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/notifications/${id}`, { method: 'DELETE' })
      if (res.ok) { toast.success('Notification config deleted.'); load() }
      else toast.error('Failed to delete notification config.')
    } catch {
      toast.error('Network error.')
    }
  }

  const toggleActive = async (c: NotificationConfigItem) => {
    try {
      const res = await fetch(`/api/notifications/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !c.isActive }),
      })
      if (res.ok) load()
      else toast.error('Failed to update config.')
    } catch {
      toast.error('Network error.')
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>Notification Channels</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Channels for scheduled-run results. Created configs appear in the Scheduler&apos;s channel selector.
            </p>
          </div>
          <Button size="sm" icon={<Bell className="h-3.5 w-3.5" />} onClick={() => { reset(); setDialogOpen(true) }}>
            Add Channel
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? <Delayed><TableSkeleton rows={3} /></Delayed> : error ? (
            <ErrorState message={error} onRetry={load} />
          ) : configs.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No channels yet. Add a Telegram bot, email recipient, or webhook.
            </div>
          ) : (
            <div className="space-y-2">
              {configs.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium truncate">{c.name}</span>
                      <Badge variant="outline" className="text-[10px] shrink-0">{c.type}</Badge>
                      {c.isActive ? (
                        <Badge variant="success" className="text-[10px] shrink-0">active</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] shrink-0">inactive</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 truncate font-mono">
                      {c.type === 'telegram' && (c.maskedConfig.botUsername ? `@${String(c.maskedConfig.botUsername)}` : 'Telegram bot')}
                      {c.type === 'email' && String(c.maskedConfig.to ?? 'email recipient')}
                      {c.type === 'webhook' && String(c.maskedConfig.url ?? 'webhook')}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => toggleActive(c)} title={c.isActive ? 'Deactivate' : 'Activate'}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => handleDelete(c.id)} title="Delete">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[480px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Notification Channel</DialogTitle>
            <DialogDescription>
              Receives scheduled-run results. Sensitive values are AES-encrypted at rest.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as NotifType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="telegram">Telegram Bot</SelectItem>
                  <SelectItem value="email">Email (Resend)</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Channel Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ops Alerts" />
            </div>

            {type === 'telegram' && (
              <>
                <div className="space-y-1.5">
                  <Label>Bot Token <span className="text-destructive">*</span></Label>
                  <Input value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456789:AAH... (from @BotFather)" className="font-mono text-xs" />
                  <p className="text-[11px] text-muted-foreground">
                    Get it from <span className="font-mono">@BotFather</span> → /newbot. Stored encrypted.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>Chat / Channel ID <span className="text-destructive">*</span></Label>
                  <Input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="123456789 or @mychannel" className="font-mono text-xs" />
                  <p className="text-[11px] text-muted-foreground">
                    For groups/channels use <span className="font-mono">@mybot</span> or message the bot once, then check <span className="font-mono">/getUpdates</span>.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>Bot Username (optional)</Label>
                  <Input value={botUsername} onChange={(e) => setBotUsername(e.target.value)} placeholder="@mybot or my_bot" className="font-mono text-xs" />
                </div>
              </>
            )}

            {type === 'email' && (
              <div className="space-y-1.5">
                <Label>Recipient Email <span className="text-destructive">*</span></Label>
                <Input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="ops@company.com" type="email" />
                <p className="text-[11px] text-muted-foreground">
                  Requires <span className="font-mono">RESEND_API_KEY</span> and <span className="font-mono">EMAIL_FROM</span> in .env.
                </p>
              </div>
            )}

            {type === 'webhook' && (
              <>
                <div className="space-y-1.5">
                  <Label>Webhook URL <span className="text-destructive">*</span></Label>
                  <Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://hooks.example.com/ryasai" className="font-mono text-xs" />
                </div>
                <div className="space-y-1.5">
                  <Label>Bearer Token (optional)</Label>
                  <Input value={webhookToken} onChange={(e) => setWebhookToken(e.target.value)} placeholder="secret" type="password" className="font-mono text-xs" />
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
              <Button
                icon={saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                onClick={handleSave}
                disabled={saving}
              >
                Save Channel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
