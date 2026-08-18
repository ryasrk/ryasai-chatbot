'use client'

import { useState } from 'react'
import { Loader2, Send } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** Shape Task 2's onCreated handler relies on — subset of the API's masked row. */
export interface CreatedChannel {
  id: string
  name: string
  type: string
  isActive: boolean
}

interface TelegramChannelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (config: CreatedChannel) => void
}

/**
 * Nested modal that creates a Telegram notification channel without leaving
 * the Add Schedule dialog. POSTs to /api/notifications and reports the new
 * channel via onCreated.
 */
export function TelegramChannelDialog({ open, onOpenChange, onCreated }: TelegramChannelDialogProps) {
  const [name, setName] = useState('')
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [botUsername, setBotUsername] = useState('')
  const [saving, setSaving] = useState(false)

  function reset() {
    setName('')
    setBotToken('')
    setChatId('')
    setBotUsername('')
  }

  async function handleSave() {
    if (!botToken.trim() || !chatId.trim()) {
      toast.error('Bot token and chat ID are required.')
      return
    }
    // Mirrors settings-view's payload: token format 123456:ABC..., chat id numeric or @channel
    const config = { botToken: botToken.trim(), chatId: chatId.trim(), botUsername: botUsername.trim() }
    const finalName = name.trim() || 'telegram config'

    setSaving(true)
    try {
      const res = await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: finalName, type: 'telegram', config }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string | { message?: string }
        config?: CreatedChannel
      }
      if (res.ok && data.ok && data.config) {
        toast.success('Notification channel saved.')
        onOpenChange(false)
        reset()
        onCreated({
          id: data.config.id,
          name: data.config.name,
          type: data.config.type,
          isActive: data.config.isActive,
        })
      } else {
        const msg = typeof data?.error === 'string' ? data.error : data?.error?.message
        toast.error(msg || 'Failed to save notification config.')
      }
    } catch {
      toast.error('Failed to save notification config.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Add Telegram Channel</DialogTitle>
          <DialogDescription className="text-xs">
            Channel for scheduled-run results. Sensitive values are AES-encrypted at rest.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Channel Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ops Alerts"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              Bot Token <span className="text-destructive">*</span>
            </Label>
            <Input
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456789:AAH... (from @BotFather)"
              className="h-8 text-xs font-mono"
            />
            <p className="text-[10px] text-muted-foreground">
              Get it from <span className="font-mono">@BotFather</span> → /newbot. Stored encrypted.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">
              Chat / Channel ID <span className="text-destructive">*</span>
            </Label>
            <Input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="123456789 or @mychannel"
              className="h-8 text-xs font-mono"
            />
            <p className="text-[10px] text-muted-foreground">
              For groups/channels use <span className="font-mono">@mybot</span> or message the bot once, then check{' '}
              <span className="font-mono">/getUpdates</span>.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Bot Username (optional)</Label>
            <Input
              value={botUsername}
              onChange={(e) => setBotUsername(e.target.value)}
              placeholder="@mybot or my_bot"
              className="h-8 text-xs font-mono"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={saving}
            className="h-7 text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            onClick={handleSave}
            disabled={saving}
            className="h-7 text-xs gap-1.5"
          >
            Save Channel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
