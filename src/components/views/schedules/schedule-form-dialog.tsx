'use client'
/**
 * The create / edit schedule dialog. It owns the form state; the view only says which schedule (if any) is being
 * edited and is told when a save landed. Mounted with a fresh `key` each time it opens, so its state starts from the
 * schedule being edited instead of whatever the previous opening left behind.
 */
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { TelegramChannelDialog, type CreatedChannel } from '@/components/telegram-channel-dialog'
import {
  BROWSER_TIMEZONE,
  buildCron,
  cronForEdit,
  type IntegrationOption,
  type NotificationConfig,
  type RepeatType,
  type Schedule,
  WEEKDAYS,
  QUICK_PRESETS,
  TIMEZONES,
  fmtInTz,
} from '@/components/views/schedules/schedule-model'
import { Plus, Loader2, Check, Bell, Database } from 'lucide-react'
import { cn } from '@/lib/utils'
import { describeCron, formatRelativeTime, previewNextRuns } from '@/lib/cron-describe'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function ScheduleFormDialog({
  open,
  onOpenChange,
  editing,
  notificationConfigs,
  integrations,
  onSaved,
  onChannelCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: Schedule | null
  notificationConfigs: NotificationConfig[]
  integrations: IntegrationOption[]
  onSaved: () => void
  onChannelCreated: (config: CreatedChannel) => void
}) {
  // An expression the simple form cannot show is kept as written; reading it as "daily" rewrote it on save.
  const initial = editing ? cronForEdit(editing.cronExpr) : null
  const [form, setForm] = useState(() => editing
    ? { name: editing.name, cronExpr: editing.cronExpr, prompt: editing.prompt, isActive: editing.isActive, notificationConfigId: editing.notificationConfigId ?? '', integrationId: editing.integrationId ?? '' }
    : { name: '', cronExpr: '', prompt: '', isActive: true, notificationConfigId: '', integrationId: '' })
  const [scheduleTime, setScheduleTime] = useState(initial?.time ?? '09:00')
  const [scheduleTimezone, setScheduleTimezone] = useState((editing?.timezone) || BROWSER_TIMEZONE)
  const timeInputRef = useRef<HTMLInputElement>(null)
  const [repeatType, setRepeatType] = useState<RepeatType>(initial?.repeat ?? 'daily')
  const [selectedDays, setSelectedDays] = useState<number[]>(initial?.selectedDays ?? [])
  const [customCron, setCustomCron] = useState<string | null>(initial?.customCron ?? null)
  const [saving, setSaving] = useState(false)
  const [telegramDialogOpen, setTelegramDialogOpen] = useState(false)

  function handleChannelCreated(config: CreatedChannel) {
    onChannelCreated(config)
    setForm((f) => ({ ...f, notificationConfigId: config.id }))
  }

  async function handleSave() {
    const cronExpr = customCron ?? buildCron(scheduleTime, repeatType, selectedDays)
    if (!form.name.trim() || !cronExpr.trim() || !form.prompt.trim()) {
      toast.error('All fields are required.')
      return
    }
    if (repeatType === 'custom' && selectedDays.length === 0) {
      toast.error('Select at least one day.')
      return
    }
    setSaving(true)
    try {
      const isEdit = editing !== null
      const url = isEdit ? `/api/schedules/${editing!.id}` : '/api/schedules'
      const method = isEdit ? 'PATCH' : 'POST'
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        cronExpr,
        prompt: form.prompt.trim(),
        isActive: form.isActive,
        notificationConfigId: form.notificationConfigId || null,
        integrationId: form.integrationId || null,
        timezone: scheduleTimezone,
      }

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok) {
        toast.success(isEdit ? 'Schedule updated.' : 'Schedule created.')
        onOpenChange(false)
        onSaved()
      } else {
        toast.error(data.error || 'Failed to save schedule.')
      }
    } catch {
      toast.error('Failed to save schedule.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {editing ? 'Edit Schedule' : 'Add Schedule'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {editing ? 'Update execution schedule details.' : 'Create a new execution schedule.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Daily sales summary"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Schedule</Label>
            {/* Quick presets */}
            <div className="flex flex-wrap gap-1.5">
              {QUICK_PRESETS.map((p) => {
                const currentCron = customCron ?? buildCron(scheduleTime, repeatType, selectedDays)
                const isActive = currentCron === p.cron
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => {
                      setCustomCron(p.cron)
                    }}
                    className={cn(
                      'text-[10px] px-2 py-1 rounded-md border transition-colors',
                      isActive
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card text-muted-foreground border-border/70 hover:bg-accent'
                    )}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
            <div className="flex items-center gap-3 rounded-none border border-border/70 p-3 bg-muted/20">
              <label className="cursor-pointer">
                <span
                  className="text-2xl font-light tracking-wide hover:text-primary transition-colors"
                  onClick={() => timeInputRef.current?.showPicker?.()}
                >
                  {scheduleTime}
                </span>
                <input
                  ref={timeInputRef}
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => { setScheduleTime(e.target.value); setCustomCron(null) }}
                  className="sr-only"
                />
              </label>
              <div className="flex-1" />
              <Select
                value={repeatType}
                onValueChange={(v) => {
                  setRepeatType(v as RepeatType)
                  setCustomCron(null)
                  if (v !== 'custom') setSelectedDays([])
                }}
              >
                <SelectTrigger className="h-8 text-xs w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Every day</SelectItem>
                  <SelectItem value="weekdays">Weekdays (Mon–Fri)</SelectItem>
                  <SelectItem value="weekends">Weekends (Sat–Sun)</SelectItem>
                  <SelectItem value="custom">Custom days...</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground shrink-0">Timezone</Label>
              <Select value={scheduleTimezone} onValueChange={setScheduleTimezone}>
                <SelectTrigger className="h-7 text-xs flex-1 min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz} className="text-xs">{tz}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {repeatType === 'custom' && (
              <div className="flex gap-1.5 flex-wrap">
                {WEEKDAYS.map((day, i) => {
                  const active = selectedDays.includes(i)
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        setSelectedDays((prev) =>
                          active ? prev.filter((d) => d !== i) : [...prev, i]
                        )
                        setCustomCron(null)
                      }}
                      className={cn(
                        'h-8 w-12 text-xs rounded-md border transition-colors',
                        active
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-card text-muted-foreground border-border/70 hover:bg-accent'
                      )}
                    >
                      {day}
                    </button>
                  )
                })}
              </div>
            )}
            {(() => {
              const cronExpr = customCron ?? buildCron(scheduleTime, repeatType, selectedDays)
              return (
                <>
                  <p className="text-xs text-muted-foreground">
                    {describeCron(cronExpr)} ({scheduleTimezone}) &nbsp; <code className="font-mono text-[10px] bg-muted/40 px-1 py-0.5 rounded">{cronExpr}</code>
                  </p>
                  {describeCron(cronExpr) !== 'Invalid cron expression' && (
                    <div className="rounded-none border border-border/70 bg-muted/20 p-2 space-y-1">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">Next 5 Executions</div>
                      {previewNextRuns(cronExpr, new Date(), 5, scheduleTimezone).map((run, i) => (
                        <div key={i} className="text-xs flex items-center gap-2">
                          <span className="text-muted-foreground">{i + 1}.</span>
                          <span>{fmtInTz(run, scheduleTimezone, true)}</span>
                          <span className="text-muted-foreground">({formatRelativeTime(run.toISOString())})</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )
            })()}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Prompt</Label>
            <Textarea
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              placeholder="Show today's sales summary"
              className="text-xs min-h-[80px]"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <Database className="h-3 w-3" />
              Data Source
            </Label>
            <Select
              value={form.integrationId || 'auto'}
              onValueChange={(v) => setForm({ ...form, integrationId: v === 'auto' ? '' : v })}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (let the AI choose)</SelectItem>
                {integrations.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.name} ({i.provider})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              {form.integrationId
                ? 'This run will be instructed to use only this source.'
                : 'The AI automatically picks the most relevant source per run.'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <Bell className="h-3 w-3" />
              Notification Channel
            </Label>
            {notificationConfigs.length > 0 ? (
              <Select
                value={form.notificationConfigId || 'none'}
                onValueChange={(v) => setForm({ ...form, notificationConfigId: v === 'none' ? '' : v })}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No notification</SelectItem>
                  {notificationConfigs.filter((c) => c.isActive).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} ({c.type})
                    </SelectItem>
                  ))}
                  <SelectSeparator />
                  {/* Sentinel value — never reaches form.notificationConfigId, just triggers modal */}
                  <SelectItem
                    value="__add_telegram__"
                    onPointerDown={(e) => e.preventDefault()}
                    onSelect={(e) => {
                      e.preventDefault()
                      setTelegramDialogOpen(true)
                    }}
                  >
                    <Plus className="h-3 w-3" /> Add Telegram channel
                  </SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <div className="flex items-center justify-between gap-2 rounded-none border border-dashed border-border/70 px-2.5 py-2 text-xs text-muted-foreground">
                <span>No channels yet — Telegram, Email &amp; Webhook are supported.</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 shrink-0 text-[11px]"
                  onClick={() => setTelegramDialogOpen(true)}
                >
                  Add channel
                </Button>
              </div>
            )}
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <Label className="text-xs">Active</Label>
            <Switch
              checked={form.isActive}
              onCheckedChange={(v) => setForm({ ...form, isActive: v })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="h-7 text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            icon={saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            onClick={handleSave}
            disabled={saving}
            className="h-7 text-xs gap-1.5"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

      <TelegramChannelDialog
        open={telegramDialogOpen}
        onOpenChange={setTelegramDialogOpen}
        onCreated={handleChannelCreated}
      />
    </>
  )
}
